use crate::{
    config::{Config, FimFormat},
    protocol::{Completion, CompletionKind, Document, offset},
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
    InputEdit {
        start_byte: start,
        old_end_byte: old_end,
        new_end_byte: new_end,
        start_position: point(old, start),
        old_end_position: point(old, old_end),
        new_end_position: point(new, new_end),
    }
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
        let mut entry = if let Some(mut old) = self.documents.remove(&doc.uri) {
            if old.doc.text != doc.text {
                // Bound diff input and output; a large edit remains a bounded summary.
                let diff = if old.doc.text.len() + doc.text.len() <= 64_000 {
                    TextDiff::from_lines(&old.doc.text, &doc.text)
                        .unified_diff()
                        .context_radius(2)
                        .header("before", "after")
                        .to_string()
                } else {
                    format!(
                        "Large edit: {} -> {} bytes",
                        old.doc.text.len(),
                        doc.text.len()
                    )
                };
                self.history
                    .push_back((doc.uri.clone(), head(&diff, 4096).to_string()));
                while self.history.len() > 10 {
                    self.history.pop_front();
                }
                if old.doc.language_id == doc.language_id {
                    if let Some(ast) = &mut old.syntax {
                        ast.tree.edit(&edit(&old.doc.text, &doc.text));
                        if let Some(tree) = ast.parser.parse(&doc.text, Some(&ast.tree)) {
                            ast.tree = tree;
                        } else {
                            old.syntax = None;
                        }
                    }
                } else {
                    old.syntax = syntax(&doc);
                }
            }
            if old.doc.language_id != doc.language_id {
                old.syntax = syntax(&doc);
            }
            old.doc = doc;
            old
        } else {
            Entry {
                syntax: syntax(&doc),
                doc,
            }
        };
        if entry.syntax.is_none() {
            entry.syntax = syntax(&entry.doc);
        }
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
        {
            return Err((-32602, "Invalid edit range or instruction"));
        }
        let mut stable = format!(
            "Project context:\n{}\nOpen symbols:\n",
            config.project_context
        );
        for (uri, other) in &self.documents {
            if uri == &request.uri {
                continue;
            }
            if let Some(ast) = &other.syntax {
                let mut walk = ast.tree.walk();
                for node in ast
                    .tree
                    .root_node()
                    .named_children(&mut walk)
                    .filter(|n| scope_kind(n.kind()))
                    .take(8)
                {
                    stable.push_str(&format!(
                        "{}: {}\n",
                        head(uri, 160),
                        signature(node, &other.doc.text)
                    ));
                }
            }
            if stable.len() > config.max_context_bytes / 4 {
                break;
            }
        }
        stable = head(&stable, config.max_context_bytes / 4).to_string();
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
        let syntax_context = head(&dynamic, config.max_context_bytes / 16).to_string();
        dynamic.clear();
        dynamic.push_str("Recent edits:\n");
        // Oldest -> newest to keep stable leading history across requests.
        for (uri, diff) in &self.history {
            dynamic.push_str(&format!("{}\n{}\n", head(uri, 160), diff));
        }
        dynamic = format!(
            "{syntax_context}{}",
            tail(
                &dynamic,
                config.max_context_bytes / 8 - syntax_context.len()
            )
        );
        let mut context = format!("{stable}\n{dynamic}");
        if next_edit {
            context.push_str(&format!(
                "\nReplace selected code using recent edits. Instruction: {}\nSelected code:\n{}\n",
                request.instruction,
                &entry.doc.text[cursor..end]
            ));
        }
        let available = config.max_context_bytes.saturating_sub(context.len() + 512);
        let prefix = tail(&entry.doc.text[..cursor], available * 3 / 4).to_string();
        let suffix = head(&entry.doc.text[end..], available / 4).to_string();
        // Prefix/suffix are separate for llama.cpp; raw APIs use explicit tokens.
        let fim = match config.fim_format {
            FimFormat::Qwen => {
                format!("{context}<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>")
            }
            FimFormat::Codestral => format!("{context}[SUFFIX]{suffix}[PREFIX]{prefix}[MIDDLE]"),
        };
        let task = if next_edit {
            "Replace the selected code using the instruction above. Return only replacement code. Do not include surrounding code or markdown.".to_string()
        } else {
            "Fill the cursor gap. Return only missing code, no explanation or markdown. Do not repeat prefix or suffix.".to_string()
        };
        let chat = format!(
            "{context}\n{task}\nLanguage: {}\n<PRE>{prefix}</PRE>\n<SUF>{suffix}</SUF>",
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
        }
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
        assert!(prompt.fim.contains("[SUFFIX]"));
    }
}
