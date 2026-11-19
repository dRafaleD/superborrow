use crate::{
    config::{Config, FimFormat},
    protocol::{Completion, CompletionKind, DiagnosticSeverity, Document, DocumentPatch, offset},
    symbols::{SymbolIndex, identifiers},
};
use similar::TextDiff;
use std::collections::{BTreeMap, VecDeque};
use tree_sitter::{InputEdit, Language, Parser, Point, Tree};

pub const MAX_DOCUMENT: usize = 512 * 1024;
const MAX_TOTAL: usize = 8 * 1024 * 1024;

struct Syntax {
    parser: Parser,
    tree: Tree,
}

struct Entry {
    doc: Document,
    syntax: Option<Syntax>,
    index: SymbolIndex,
}

#[derive(Default)]
pub struct ContextEngine {
    documents: BTreeMap<String, Entry>,
    history: VecDeque<(String, String)>,
}

#[derive(Clone)]
pub struct Prompt {
    pub stable: String,
    pub prefix: String,
    pub suffix: String,
    pub fim: String,
    pub chat: String,
    pub language_id: String,
    pub next_edit: bool,
    pub complex: bool,
    pub format: FimFormat,
    bounded_member: bool,
}

impl Prompt {
    pub fn qwen_infill(&self) -> Option<String> {
        if self.next_edit || !matches!(self.format, FimFormat::Qwen) {
            return None;
        }
        // The raw FIM model expects source around its sentinel tokens. Chat
        // history such as unified diffs belongs in the instruction prompt.
        Some(format!(
            "<|fim_prefix|>{}{}<|fim_suffix|>{}<|fim_middle|>",
            if self.language_id == "rust" {
                "// Language: Rust\n"
            } else {
                ""
            },
            self.prefix,
            self.suffix
        ))
    }

    pub fn qwen_stop_at(&self) -> Option<&'static str> {
        if self.next_edit || !matches!(self.format, FimFormat::Qwen) {
            return None;
        }
        let mut lines = self.prefix.rsplit('\n');
        let current = lines.next().unwrap_or_default();
        let line = current.trim_start();
        let trimmed = line.trim_end();
        if self.language_id != "rust"
            && !line.starts_with(['#', '/'])
            && !trimmed.ends_with(['(', '[', '{', ':', ','])
            && (line.starts_with("return ") || line.starts_with("yield ") || trimmed.ends_with('.'))
        {
            return Some("line");
        }
        if self.bounded_member || short_expression_gap(&self.language_id, trimmed, &self.suffix) {
            return Some("line");
        }
        if self.language_id == "python"
            && current.is_empty()
            && let Some(comment) = lines.next().and_then(|line| line.strip_prefix('#'))
        {
            let comment = comment.to_lowercase();
            if ["a function", "one function", "bir fonksiyon"]
                .iter()
                .any(|phrase| comment.contains(phrase))
            {
                return Some("pythonFunction");
            }
        }
        None
    }
}

fn bounded_member_gap(entry: &Entry, cursor: usize) -> bool {
    let Some(syntax) = &entry.syntax else {
        return false;
    };
    let suffix = entry.doc.text[cursor..].trim_start_matches([' ', '\t']);
    if !suffix.starts_with([';', ')', ']', ',', '('])
        && !(matches!(
            entry.doc.language_id.as_str(),
            "javascript" | "javascriptreact" | "typescript" | "typescriptreact"
        ) && suffix.starts_with("??"))
    {
        return false;
    }
    // Match the property node itself so a decimal, spread, comment, or
    // string containing a dot doesn't change the generation boundary.
    let Some(name) = cursor.checked_sub(1).and_then(|start| {
        syntax
            .tree
            .root_node()
            .descendant_for_byte_range(start, cursor)
    }) else {
        return false;
    };
    if name.end_byte() != cursor {
        return false;
    }
    name.parent().is_some_and(|node| match node.kind() {
        "member_expression" => node.child_by_field_name("property") == Some(name),
        "field_expression" => node.child_by_field_name("field") == Some(name),
        "attribute" => node.child_by_field_name("attribute") == Some(name),
        _ => false,
    })
}

fn short_expression_gap(language: &str, line: &str, suffix: &str) -> bool {
    let python = language == "python";
    if !python
        && !matches!(
            language,
            "javascript" | "javascriptreact" | "typescript" | "typescriptreact"
        )
    {
        return false;
    }
    // Treat quotes, comments and incomplete block delimiters as ordinary FIM.
    if line.contains(['\'', '"', '`', '#']) || line.contains("//") || line.contains("/*") {
        return false;
    }
    let end_of_line = suffix.split('\n').next().unwrap_or_default().trim();
    if !end_of_line
        .bytes()
        .all(|byte| matches!(byte, b')' | b']' | b';' | b' ' | b'\t'))
    {
        return false;
    }
    if line.ends_with(['+', '-', '*', '/', '%', '&', '|', '^']) {
        return !end_of_line.is_empty() || (python && line.contains('='));
    }
    // A return/yield with a final argument before an existing close paren is
    // a bounded expression, even though the text before the caret ends in a comma.
    (line.starts_with("return ") || line.starts_with("yield "))
        && line.ends_with(',')
        && end_of_line.starts_with(')')
}

pub fn head(text: &str, max: usize) -> &str {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn tail(text: &str, max: usize) -> &str {
    let mut start = text.len().saturating_sub(max);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

fn point(text: &str, byte: usize) -> Point {
    let prefix = &text[..byte];
    Point::new(
        prefix.bytes().filter(|b| *b == b'\n').count(),
        prefix.rfind('\n').map_or(byte, |i| byte - i - 1),
    )
}

fn advance_point(start: Point, text: &str) -> Point {
    let rows = text.bytes().filter(|b| *b == b'\n').count();
    let column = text
        .rfind('\n')
        .map_or(start.column + text.len(), |index| text.len() - index - 1);
    Point::new(start.row + rows, column)
}

fn language(id: &str) -> Option<Language> {
    Some(match id {
        "rust" => tree_sitter_rust::LANGUAGE.into(),
        "typescript" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "typescriptreact" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "javascript" | "javascriptreact" => tree_sitter_javascript::LANGUAGE.into(),
        "python" => tree_sitter_python::LANGUAGE.into(),
        _ => return None,
    })
}

fn syntax(doc: &Document) -> Option<Syntax> {
    let mut parser = Parser::new();
    parser.set_language(&language(&doc.language_id)?).ok()?;
    let tree = parser.parse(&doc.text, None)?;
    Some(Syntax { parser, tree })
}

fn edit(old: &str, new: &str) -> InputEdit {
    let mut start = old
        .bytes()
        .zip(new.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(start) || !new.is_char_boundary(start) {
        start -= 1;
    }
    let mut shared = old[start..]
        .bytes()
        .rev()
        .zip(new[start..].bytes().rev())
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(old.len() - shared) || !new.is_char_boundary(new.len() - shared) {
        shared -= 1;
    }
    let old_end = old.len() - shared;
    let new_end = new.len() - shared;
    let start_position = point(old, start);
    InputEdit {
        start_byte: start,
        old_end_byte: old_end,
        new_end_byte: new_end,
        start_position,
        old_end_position: advance_point(start_position, &old[start..old_end]),
        new_end_position: advance_point(start_position, &new[start..new_end]),
    }
}

fn edit_history(old: &str, new: &str, changed: &InputEdit) -> String {
    fn lines_around(text: &str, start: usize, end: usize) -> &str {
        let start = text[..start]
            .rmatch_indices('\n')
            .nth(2)
            .map_or(0, |(i, _)| i + 1);
        let end = text[end..]
            .match_indices('\n')
            .nth(2)
            .map_or(text.len(), |(i, _)| end + i + 1);
        &text[start..end]
    }

    let before = lines_around(old, changed.start_byte, changed.old_end_byte);
    let after = lines_around(new, changed.start_byte, changed.new_end_byte);
    let line = changed.start_position.row + 1;
    if before.len() + after.len() > 8192 {
        return format!(
            "Large edit at line {line}: {} → {} bytes",
            changed.old_end_byte - changed.start_byte,
            changed.new_end_byte - changed.start_byte
        );
    }
    let header = format!("before (near line {line})");
    let diff = TextDiff::from_lines(before, after)
        .unified_diff()
        .context_radius(2)
        .header(&header, "after")
        .to_string();
    head(&diff, 4096).to_string()
}

fn scope_kind(kind: &str) -> bool {
    matches!(
        kind,
        "function_item"
            | "function_definition"
            | "function_declaration"
            | "method_definition"
            | "arrow_function"
            | "class_definition"
            | "class_declaration"
            | "impl_item"
            | "struct_item"
            | "interface_declaration"
    )
}

fn signature(node: tree_sitter::Node<'_>, text: &str) -> String {
    let end = node
        .child_by_field_name("body")
        .map_or(node.end_byte(), |body| body.start_byte());
    head(text[node.start_byte()..end].trim(), 300).to_string()
}

impl ContextEngine {
    pub fn version(&self, uri: &str) -> Option<u32> {
        self.documents.get(uri).map(|e| e.doc.version)
    }

    pub fn update(&mut self, doc: Document) -> Result<(), (i32, &'static str)> {
        self.update_with_edit(doc, None)
    }

    pub fn patch(&mut self, patch: DocumentPatch) -> Result<(), (i32, &'static str)> {
        const INVALID_RANGE: (i32, &str) = (-32602, "Invalid UTF-16 patch range");
        let base = &self
            .documents
            .get(&patch.uri)
            .ok_or((-32801, "Patch base missing"))?
            .doc;
        if base.version != patch.base_version || patch.version <= patch.base_version {
            return Err((-32801, "Patch version mismatch"));
        }
        let start = offset(&base.text, &patch.start).ok_or(INVALID_RANGE)?;
        let end = offset(&base.text, &patch.end).ok_or(INVALID_RANGE)?;
        if start > end {
            return Err(INVALID_RANGE);
        }
        let size = base.text.len() - (end - start) + patch.text.len();
        if size > MAX_DOCUMENT || patch.text.len() > 8192 {
            return Err((-32602, "Document patch exceeds size limit"));
        }
        let column = base.text[..start]
            .rfind('\n')
            .map_or(start, |i| start - i - 1);
        let start_position = Point::new(patch.start.line, column);
        let change = InputEdit {
            start_byte: start,
            old_end_byte: end,
            new_end_byte: start + patch.text.len(),
            start_position,
            old_end_position: advance_point(start_position, &base.text[start..end]),
            new_end_position: advance_point(start_position, &patch.text),
        };
        let mut text = String::with_capacity(size);
        text.push_str(&base.text[..start]);
        text.push_str(&patch.text);
        text.push_str(&base.text[end..]);
        let known_edit = (base.text[start..end] != patch.text).then_some(change);
        self.update_with_edit(
            Document {
                uri: patch.uri,
                language_id: base.language_id.clone(),
                version: patch.version,
                text,
            },
            known_edit,
        )
    }

    fn update_with_edit(
        &mut self,
        doc: Document,
        known_edit: Option<InputEdit>,
    ) -> Result<(), (i32, &'static str)> {
        if doc.text.len() > MAX_DOCUMENT || doc.uri.len() > 4096 || doc.language_id.len() > 64 {
            return Err((-32602, "Document exceeds size limit"));
        }
        let previous = self.documents.get(&doc.uri);
        if previous.is_some_and(|e| e.doc.version >= doc.version) {
            return Err((-32801, "Document version must increase"));
        }
        let total: usize = self.documents.values().map(|e| e.doc.text.len()).sum();
        if total - previous.map_or(0, |e| e.doc.text.len()) + doc.text.len() > MAX_TOTAL
            || (previous.is_none() && self.documents.len() >= 32)
        {
            return Err((-32005, "Open document context limit reached"));
        }
        let entry = if let Some(mut old) = self.documents.remove(&doc.uri) {
            let same_language = old.doc.language_id == doc.language_id;
            let text_changed = known_edit.is_some() || old.doc.text != doc.text;
            if text_changed {
                let change = known_edit.unwrap_or_else(|| edit(&old.doc.text, &doc.text));
                self.history.push_back((
                    doc.uri.clone(),
                    edit_history(&old.doc.text, &doc.text, &change),
                ));
                while self.history.len() > 10 {
                    self.history.pop_front();
                }
                if same_language && let Some(ast) = &mut old.syntax {
                    ast.tree.edit(&change);
                    if let Some(tree) = ast.parser.parse(&doc.text, Some(&ast.tree)) {
                        ast.tree = tree;
                    } else {
                        old.syntax = None;
                    }
                }
            }
            let changed = text_changed || !same_language;
            if !same_language || (text_changed && old.syntax.is_none()) {
                old.syntax = syntax(&doc);
            }
            if changed {
                old.index = SymbolIndex::build(&doc.text, old.syntax.as_ref().map(|ast| &ast.tree));
            }
            old.doc = doc;
            old
        } else {
            let syntax = syntax(&doc);
            let index = SymbolIndex::build(&doc.text, syntax.as_ref().map(|ast| &ast.tree));
            Entry { doc, syntax, index }
        };
        self.documents.insert(entry.doc.uri.clone(), entry);
        Ok(())
    }

    pub fn close(&mut self, uri: &str) {
        self.documents.remove(uri);
        self.history.retain(|(source, _)| source != uri);
    }

    pub fn prompt(
        &self,
        request: &Completion,
        config: &Config,
    ) -> Result<Prompt, (i32, &'static str)> {
        let entry = self
            .documents
            .get(&request.uri)
            .ok_or((-32602, "Unknown document"))?;
        if entry.doc.version != request.version {
            return Err((-32801, "Document changed"));
        }
        let cursor = offset(&entry.doc.text, &request.position)
            .ok_or((-32602, "Invalid UTF-16 position"))?;
        let next_edit = request.kind == CompletionKind::NextEdit;
        let end = if next_edit {
            offset(
                &entry.doc.text,
                request
                    .end_position
                    .as_ref()
                    .ok_or((-32602, "Next edit requires endPosition"))?,
            )
            .ok_or((-32602, "Invalid end position"))?
        } else {
            cursor
        };
        if end < cursor
            || end - cursor > 16_384.min(config.max_context_bytes / 4)
            || request.instruction.len() > 2048.min(config.max_context_bytes / 8)
            || request.diagnostics.len() > 8
            || request.related_documents.len() > 4
            || request.related_documents.iter().any(|doc| {
                doc.text.len() > 65_536 || doc.uri.len() > 4096 || doc.language_id.len() > 64
            })
            || request
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.message.len() > 512)
        {
            return Err((-32602, "Invalid edit range or instruction"));
        }
        let task = if next_edit {
            "Replace the selected code following the instruction. Return replacement code only; omit surrounding code, explanations and markdown."
        } else {
            "Fill only the cursor gap in the ACTIVE file (<PRE> and <SUF>). Other sections are references, not code to continue. Follow the latest nearby request comment in its language; obey the stated programming Language even if the comment marker belongs to another language. Implement requested behavior fully, including a declaration if needed. No pass, TODO, ellipsis, NotImplementedError or empty body unless a stub/skeleton is explicitly requested. If a new function's behavior is unspecified (e.g. 'create function'), return exactly <NO_COMPLETION>. Match existing names and indentation. For expression gaps finish the expression; for behavior comments complete the requested implementation. Prefer the smallest useful code unit. Do not add examples/tests unless requested. Return missing code only. Omit markdown, explanations, and comments that restate the code. Prefix and suffix remain in the file: do not repeat them."
        };
        let task = if entry.doc.language_id == "rust" && !next_edit {
            format!(
                "{task} For Rust, use the visible types and signatures. Preserve borrowing, mutability and Result/Option handling. Do not invent APIs, replace error propagation with unwrap, or repeat a delimiter that already follows the gap."
            )
        } else {
            task.to_owned()
        };
        // The byte budget includes chat instructions and framing, not just FIM.
        let framing = format!(
            "{task}\nLanguage: {}\n\n<PRE></PRE>\n<SUF></SUF>",
            entry.doc.language_id
        )
        .len();
        let budget = config.max_context_bytes.saturating_sub(framing.max(64));
        let stable_budget = budget / 4;
        let mut stable = format!(
            "Project context:\n{}\n",
            head(&config.project_context, stable_budget / 3)
        );
        if cursor > budget / 2 && !entry.index.headers.is_empty() {
            stable.push_str("Active file imports:\n");
            stable.push_str(head(&entry.index.headers, stable_budget / 4));
        }
        let query = format!(
            "{}\n{}\n{}",
            tail(&entry.doc.text[..cursor], 3072),
            head(&entry.doc.text[end..], 1024),
            entry.index.headers
        );
        let terms = identifiers(&query);
        // Request-scoped references never enter the persistent document/history
        // store. An open (possibly unsaved) editor buffer always takes priority.
        let mut related = BTreeMap::new();
        for doc in &request.related_documents {
            if self.documents.contains_key(&doc.uri) || related.contains_key(&doc.uri) {
                continue;
            }
            let syntax = syntax(doc);
            let index = SymbolIndex::build(&doc.text, syntax.as_ref().map(|value| &value.tree));
            related.insert(
                doc.uri.clone(),
                Entry {
                    doc: doc.clone(),
                    syntax,
                    index,
                },
            );
        }
        let mut candidates = Vec::new();
        for (uri, other) in self.documents.iter().chain(related.iter()) {
            if entry.doc.language_id == "rust" && other.doc.language_id != "rust" {
                continue;
            }
            let filename = uri.rsplit('/').next().unwrap_or(uri);
            let stem = filename.rsplit_once('.').map_or(filename, |(stem, _)| stem);
            let imported = stem.len() >= 3 && entry.index.headers.contains(stem);
            for symbol in &other.index.symbols {
                let same_file = uri == &request.uri;
                if same_file && symbol.start <= cursor && cursor <= symbol.end {
                    continue;
                }
                let direct = terms.contains(symbol.name.as_str());
                let owner = !symbol.owner.is_empty() && terms.contains(symbol.owner.as_str());
                // Unrelated open files cannot crowd out referenced APIs/types.
                if !same_file && !direct && !owner && !imported {
                    continue;
                }
                let score = usize::from(imported) * 24
                    + usize::from(direct) * 20
                    + usize::from(owner) * 12
                    + usize::from(same_file) * 4;
                candidates.push((score, uri, symbol));
            }
        }
        candidates.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| a.1.cmp(b.1))
                .then_with(|| a.2.start.cmp(&b.2.start))
        });
        stable.push_str("Relevant symbols (references only):\n");
        for (_, uri, symbol) in candidates.into_iter().take(12) {
            let label = if uri == &request.uri {
                "active file"
            } else {
                head(uri, 160)
            };
            let owner = if symbol.owner.is_empty() {
                String::new()
            } else {
                format!("{}::", symbol.owner)
            };
            let line = format!("{label}: {owner}{}\n", symbol.signature);
            if stable.len() + line.len() <= stable_budget {
                stable.push_str(&line);
            }
        }
        stable = head(&stable, stable_budget).to_string();
        let mut dynamic = String::new();
        if let Some(ast) = &entry.syntax {
            dynamic.push_str(&format!(
                "Syntax incomplete: {}\n",
                ast.tree.root_node().has_error()
            ));
            let mut node = ast
                .tree
                .root_node()
                .descendant_for_byte_range(cursor, cursor);
            while let Some(current) = node {
                if scope_kind(current.kind()) {
                    dynamic.push_str(&format!(
                        "Enclosing {}: {} (lines {}-{}; incomplete: {})\n",
                        current.kind(),
                        signature(current, &entry.doc.text),
                        current.start_position().row + 1,
                        current.end_position().row + 1,
                        current.has_error()
                    ));
                    break;
                }
                node = current.parent();
            }
        }
        let syntax_context = head(&dynamic, budget / 16).to_string();
        let mut diagnostic_context = String::new();
        for diagnostic in &request.diagnostics {
            if offset(&entry.doc.text, &diagnostic.position).is_none()
                || diagnostic.position.line.abs_diff(request.position.line) > 32
            {
                continue;
            }
            let severity = match diagnostic.severity {
                DiagnosticSeverity::Error => "error",
                DiagnosticSeverity::Warning => "warning",
            };
            diagnostic_context.push_str(&format!(
                "{severity} at {}:{}: {}\n",
                diagnostic.position.line + 1,
                diagnostic.position.character + 1,
                diagnostic.message
            ));
        }
        let advisory = if diagnostic_context.is_empty() {
            String::new()
        } else {
            format!(
                "Nearby editor diagnostics (advisory; may lag edits):\n{}",
                head(&diagnostic_context, budget / 16)
            )
        };
        let syntax_context = head(&format!("{advisory}{syntax_context}"), budget / 8).to_string();
        dynamic.clear();
        dynamic.push_str("Recent edits:\n");
        // Oldest -> newest to keep stable leading history across requests.
        for (uri, diff) in &self.history {
            if entry.doc.language_id == "rust"
                && !self
                    .documents
                    .get(uri)
                    .is_some_and(|source| source.doc.language_id == "rust")
            {
                continue;
            }
            dynamic.push_str(&format!("{}\n{}\n", head(uri, 160), diff));
        }
        dynamic = format!(
            "{syntax_context}{}",
            tail(&dynamic, budget / 8 - syntax_context.len())
        );
        let mut context = format!("{stable}\n{dynamic}");
        if next_edit {
            context.push_str(&format!(
                "\nReplace selected code using recent edits. Instruction: {}\nSelected code:\n{}\n",
                request.instruction,
                &entry.doc.text[cursor..end]
            ));
        }
        let available = budget.saturating_sub(context.len());
        let prefix = tail(&entry.doc.text[..cursor], available * 3 / 4).to_string();
        let suffix = head(&entry.doc.text[end..], available / 4).to_string();
        // Prefix/suffix are separate for llama.cpp; raw APIs use explicit tokens.
        let fim = match config.fim_format {
            FimFormat::Qwen => {
                format!("{context}<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>")
            }
            FimFormat::Codestral => format!("{context}[SUFFIX]{suffix}[PREFIX]{prefix}[MIDDLE]"),
        };
        let chat = format!(
            "{task}\nLanguage: {}\n{context}\n<PRE>{prefix}</PRE>\n<SUF>{suffix}</SUF>",
            entry.doc.language_id
        );
        let complex = next_edit
            || entry.doc.text[..cursor]
                .lines()
                .next_back()
                .is_some_and(|line| line.trim_end().ends_with(['{', ':']))
            || prefix.len() > 12_000;
        Ok(Prompt {
            stable: context,
            prefix,
            suffix,
            fim,
            chat,
            language_id: entry.doc.language_id.clone(),
            next_edit,
            complex,
            format: config.fim_format,
            bounded_member: !next_edit
                && config.fim_format == FimFormat::Qwen
                && bounded_member_gap(entry, cursor),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Mode, Position};
    fn doc(version: u32, text: &str) -> Document {
        Document {
            uri: "file:///a.rs".into(),
            language_id: "rust".into(),
            version,
            text: text.into(),
        }
    }
    fn request(version: u32) -> Completion {
        Completion {
            uri: "file:///a.rs".into(),
            version,
            position: Position {
                line: 1,
                character: 4,
            },
            mode: Mode::Local,
            kind: CompletionKind::Inline,
            end_position: None,
            instruction: String::new(),
            explicit: false,
            diagnostics: Vec::new(),
            related_documents: Vec::new(),
        }
    }
    fn at_end(uri: &str, text: &str) -> Completion {
        let mut value = request(1);
        value.uri = uri.into();
        value.position = Position {
            line: text.matches('\n').count(),
            character: text
                .rsplit('\n')
                .next()
                .unwrap_or("")
                .encode_utf16()
                .count(),
        };
        value
    }

    #[test]
    fn referenced_exported_apis_and_type_shapes_win_over_unrelated_open_files() {
        let mut engine = ContextEngine::default();
        for i in 0..14 {
            engine
                .update(Document {
                    uri: format!("file:///aaa-{i}.ts"),
                    version: 1,
                    language_id: "typescript".into(),
                    text: format!(
                        "export function unrelated_{i}(value: string): string {{ return value; }}"
                    ),
                })
                .unwrap();
        }
        engine.update(Document { uri: "file:///zzz-service.ts".into(), version: 1, language_id: "typescript".into(), text: "export interface Invoice { currency: string; cents: number; }\nexport function normalizeInvoice(invoice: Invoice): Invoice { return invoice; }".into() }).unwrap();
        let active = "import { normalizeInvoice, Invoice } from './zzz-service';\nconst result = normalizeInvoice(";
        let uri = "file:///main.ts";
        engine
            .update(Document {
                uri: uri.into(),
                version: 1,
                language_id: "typescript".into(),
                text: active.into(),
            })
            .unwrap();
        let prompt = engine
            .prompt(
                &at_end(uri, active),
                &Config {
                    max_context_bytes: 4096,
                    ..Config::default()
                },
            )
            .unwrap();
        assert!(
            prompt
                .stable
                .contains("normalizeInvoice(invoice: Invoice): Invoice")
        );
        assert!(prompt.stable.contains("currency: string"));
        assert!(!prompt.stable.contains("unrelated_"));
    }

    #[test]
    fn long_files_keep_imports_and_referenced_active_file_declarations() {
        let mut engine = ContextEngine::default();
        let text = format!(
            "import {{ Invoice }} from './types';\n{}\nfunction normalizeInvoice(invoice: Invoice): Invoice {{ return invoice; }}\n{}\nconst result = normalizeInvoice(",
            "// filler 😀\n".repeat(1500),
            "// filler 😀\n".repeat(1500)
        );
        let uri = "file:///main.ts";
        engine
            .update(Document {
                uri: uri.into(),
                version: 1,
                language_id: "typescript".into(),
                text: text.clone(),
            })
            .unwrap();
        let prompt = engine
            .prompt(
                &at_end(uri, &text),
                &Config {
                    max_context_bytes: 4096,
                    ..Config::default()
                },
            )
            .unwrap();
        assert!(!prompt.prefix.contains("import { Invoice }"));
        assert!(prompt.stable.contains("import { Invoice }"));
        assert!(
            prompt
                .stable
                .contains("normalizeInvoice(invoice: Invoice): Invoice")
        );
    }

    #[test]
    fn symbol_index_refreshes_after_changes_and_close() {
        let mut engine = ContextEngine::default();
        let mut helper = Document {
            uri: "file:///helper.ts".into(),
            version: 1,
            language_id: "typescript".into(),
            text: "export function convert(value: string): number { return 1; }".into(),
        };
        engine.update(helper.clone()).unwrap();
        let active = "const x = convert(";
        let uri = "file:///main.ts";
        engine
            .update(Document {
                uri: uri.into(),
                version: 1,
                language_id: "typescript".into(),
                text: active.into(),
            })
            .unwrap();
        let completion = at_end(uri, active);
        assert!(
            engine
                .prompt(&completion, &Config::default())
                .unwrap()
                .stable
                .contains("convert(value: string): number")
        );
        helper.version = 2;
        helper.text = "export function convert(value: string): boolean { return true; }".into();
        engine.update(helper.clone()).unwrap();
        let prompt = engine.prompt(&completion, &Config::default()).unwrap();
        assert!(prompt.stable.contains("convert(value: string): boolean"));
        assert!(
            !prompt
                .stable
                .split("Recent edits:")
                .next()
                .unwrap()
                .contains("convert(value: string): number")
        );
        engine.close(&helper.uri);
        assert!(
            !engine
                .prompt(&completion, &Config::default())
                .unwrap()
                .stable
                .contains("convert(value:")
        );
    }
    #[test]
    fn incremental_parse_history_and_prompt_order() {
        let mut engine = ContextEngine::default();
        engine.update(doc(1, "fn main() {\n    \n}")).unwrap();
        for version in 2..=14 {
            engine
                .update(doc(
                    version,
                    &format!("fn main() {{\n    // 😀 {version}\n}}"),
                ))
                .unwrap();
        }
        assert_eq!(engine.history.len(), 10);
        let ast = engine
            .documents
            .values()
            .next()
            .unwrap()
            .syntax
            .as_ref()
            .unwrap();
        let mut fresh = Parser::new();
        fresh
            .set_language(&tree_sitter_rust::LANGUAGE.into())
            .unwrap();
        assert_eq!(
            ast.tree.root_node().to_sexp(),
            fresh
                .parse(&engine.documents.values().next().unwrap().doc.text, None)
                .unwrap()
                .root_node()
                .to_sexp()
        );
        let prompt = engine.prompt(&request(14), &Config::default()).unwrap();
        assert!(prompt.chat.contains("Enclosing function_item"));
        assert!(
            prompt.fim.find("Project context").unwrap()
                < prompt.fim.find("<|fim_prefix|>").unwrap()
        );
        assert!(prompt.fim.ends_with("<|fim_middle|>"));
        engine.close("file:///a.rs");
        assert!(engine.history.is_empty());
    }
    #[test]
    fn unicode_edits_and_bounded_context() {
        let change = edit("a😀c", "a😎c");
        assert_eq!(
            (change.start_byte, change.old_end_byte, change.new_end_byte),
            (1, 5, 5)
        );
        let mut engine = ContextEngine::default();
        engine
            .update(doc(
                1,
                &format!("fn a() {{\n    {}\n}}", "a".repeat(40_000)),
            ))
            .unwrap();
        let config = Config {
            max_context_bytes: 2048,
            fim_format: FimFormat::Codestral,
            ..Config::default()
        };
        let prompt = engine.prompt(&request(1), &config).unwrap();
        assert!(prompt.fim.len() <= config.max_context_bytes);
        assert!(prompt.chat.len() <= config.max_context_bytes);
        assert!(prompt.fim.contains("[SUFFIX]"));
    }

    #[test]
    fn small_crlf_change_in_a_large_file_keeps_the_actual_edit() {
        let prefix = "// unrelated context\r\n".repeat(6000);
        let before = format!("{prefix}const label = '😀';\r\nconst next = 1;\r\n");
        let after = format!("{prefix}const label = '💡';\r\nconst next = 1;\r\n");
        let change = edit(&before, &after);
        assert_eq!(change.start_position.row, 6000);
        let diff = edit_history(&before, &after, &change);
        assert!(diff.contains("near line 6001"));
        assert!(diff.contains("-const label = '😀';\r\n"));
        assert!(diff.contains("+const label = '💡';\r\n"));
        assert!(diff.len() < 1024);
    }

    #[test]
    fn infill_boundary_distinguishes_comment_requests_from_expression_gaps() {
        let mut engine = ContextEngine::default();
        let uri = "file:///demo.py";
        for (version, text, expected) in [
            (
                1,
                "# İki sayının büyük olanını döndüren bir fonksiyon yaz.\n",
                Some("pythonFunction"),
            ),
            (2, "def calculate(a, b):\n    return a + ", Some("line")),
            (3, "def calculate(a, b):\n    return (", None),
        ] {
            engine
                .update(Document {
                    uri: uri.into(),
                    language_id: "python".into(),
                    version,
                    text: text.into(),
                })
                .unwrap();
            let mut completion = at_end(uri, text);
            completion.version = version;
            let prompt = engine.prompt(&completion, &Config::default()).unwrap();
            assert_eq!(prompt.qwen_stop_at(), expected);
        }
    }

    #[test]
    fn short_gap_boundary_uses_existing_line_closers_and_preserves_blocks() {
        let mut engine = ContextEngine::default();
        let uri = "file:///short-gap";
        let cases = [
            (
                "typescript",
                "  const total = a + ",
                ";\r\n  return total;",
                Some("line"),
            ),
            (
                "javascript",
                "const values = rows.map(row => row.id * ",
                ");\n",
                Some("line"),
            ),
            ("typescript", "  return Math.max(a, ", ");\n}", Some("line")),
            (
                "python",
                "    result = a + ",
                "\n    return result",
                Some("line"),
            ),
            ("python", "    return max(a, ", ")\n", Some("line")),
            (
                "typescript",
                "const label = account.display",
                ";\n",
                Some("line"),
            ),
            (
                "typescript",
                "const price = invoice?.unitPric",
                " ?? 0;\n",
                Some("line"),
            ),
            (
                "javascript",
                "const label = account().toUpper",
                "();\n",
                Some("line"),
            ),
            (
                "python",
                "    value = process(item.disp",
                ")\n",
                Some("line"),
            ),
            ("javascript", "const label = account.display", "\n", None),
            ("typescript", "  const n = 0.5", ";\n", None),
            ("typescript", "  const list = [...acc", "];\n", None),
            ("typescript", "// example account.display", ";\n", None),
            (
                "typescript",
                "/* explanation\n account.display",
                ";\n*/",
                None,
            ),
            (
                "javascript",
                "const text = 'example account.display",
                ";'\n",
                None,
            ),
            ("typescript", "const options = {\n  ", "\n};", None),
            (
                "typescript",
                "function choose(a: number, ",
                "): number {}",
                None,
            ),
            ("typescript", "// Example + ", ";\n", None),
            ("typescript", "const text = `some + ", ";\n", None),
            ("python", "    s = '''some + ", "\n", None),
            ("python", "    result += ", " # keep the comment\n", None),
            (
                "rust",
                "fn read(config: Config) { let x = config.time",
                "; }",
                Some("line"),
            ),
            (
                "rust",
                "fn read(config: Config) { config.retr",
                "(); }",
                Some("line"),
            ),
            ("rust", "fn read() {\n    let x = config.time", "\n}", None),
            ("rust", "fn read() {\n    // config.time", ";\n}", None),
            ("rust", "fn read() {\n    let x = 0.5", ";\n}", None),
            (
                "rust",
                "fn read() {\n    return match result {",
                "\n    };\n}",
                None,
            ),
            ("rust", "fn read() {\n    return build().", "\n}", None),
        ];
        for (index, (language, prefix, suffix, expected)) in cases.iter().enumerate() {
            let version = index as u32 + 1;
            engine
                .update(Document {
                    uri: uri.into(),
                    language_id: (*language).into(),
                    version,
                    text: format!("{prefix}{suffix}"),
                })
                .unwrap();
            let mut completion = at_end(uri, prefix);
            completion.version = version;
            let prompt = engine.prompt(&completion, &Config::default()).unwrap();
            assert_eq!(prompt.qwen_stop_at(), *expected, "{language} {prefix:?}");
        }
    }

    #[test]
    fn prompt_budget_covers_instructions_and_maximum_edit_context() {
        let mut engine = ContextEngine::default();
        let text = format!(
            "fn main() {{\n    {}{}",
            "x".repeat(20000),
            "😀".repeat(10000)
        );
        engine.update(doc(1, &text)).unwrap();
        for max_context_bytes in [2048, 4096, 24000, 64000] {
            let config = Config {
                max_context_bytes,
                project_context: "project".repeat(1000),
                ..Config::default()
            };
            let mut completion = request(1);
            let inline = engine.prompt(&completion, &config).unwrap();
            assert!(inline.chat.len() <= max_context_bytes);
            assert!(inline.fim.len() <= max_context_bytes);
            completion.kind = CompletionKind::NextEdit;
            completion.end_position = Some(Position {
                line: 1,
                character: 4 + (max_context_bytes / 4).min(16384),
            });
            completion.instruction = "x".repeat((max_context_bytes / 8).min(2048));
            let edit = engine.prompt(&completion, &config).unwrap();
            assert!(edit.chat.len() <= max_context_bytes);
            assert!(edit.fim.len() <= max_context_bytes);
        }
    }

    #[test]
    fn default_import_alias_keeps_the_exported_class_api() {
        let mut engine = ContextEngine::default();
        engine.update(Document { uri: "file:///backend-client.ts".into(), version: 1, language_id: "typescript".into(), text: "export default class BackendClient { lookupInvoice(id: string): string { return id; } }".into() }).unwrap();
        let active =
            "import Api from './backend-client';\nconst client = new Api();\nclient.lookup";
        let uri = "file:///main.ts";
        engine
            .update(Document {
                uri: uri.into(),
                version: 1,
                language_id: "typescript".into(),
                text: active.into(),
            })
            .unwrap();
        let prompt = engine
            .prompt(&at_end(uri, active), &Config::default())
            .unwrap();
        assert!(
            prompt
                .stable
                .contains("BackendClient::lookupInvoice(id: string): string")
        );
    }
}
