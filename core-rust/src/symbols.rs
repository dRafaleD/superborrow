use crate::context::head;
use std::collections::BTreeSet;
use tree_sitter::{Node, Tree};

pub struct Symbol {
    pub name: String,
    pub owner: String,
    pub signature: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Default)]
pub struct SymbolIndex {
    pub headers: String,
    pub symbols: Vec<Symbol>,
}

pub fn identifiers(text: &str) -> BTreeSet<&str> {
    text.split(|ch: char| !ch.is_alphanumeric() && ch != '_' && ch != '$')
        .filter(|part| !part.is_empty())
        .collect()
}

fn type_kind(kind: &str) -> bool {
    matches!(
        kind,
        "struct_item"
            | "enum_item"
            | "interface_declaration"
            | "type_alias_declaration"
            | "type_item"
            | "trait_item"
    )
}

fn symbol_kind(kind: &str) -> bool {
    type_kind(kind)
        || matches!(
            kind,
            "function_item"
                | "function_signature_item"
                | "function_definition"
                | "function_declaration"
                | "method_definition"
                | "method_signature"
                | "class_definition"
                | "class_declaration"
                | "variable_declarator"
                | "public_field_definition"
        )
}

fn owner(node: Node<'_>, text: &str) -> String {
    let mut ancestor = node.parent();
    for _ in 0..6 {
        let Some(parent) = ancestor else {
            break;
        };
        if matches!(
            parent.kind(),
            "class_definition" | "class_declaration" | "impl_item" | "trait_item"
        ) {
            let name = parent
                .child_by_field_name("name")
                .or_else(|| parent.child_by_field_name("type"));
            if let Some(name) = name {
                return head(&text[name.byte_range()], 128).to_string();
            }
        }
        ancestor = parent.parent();
    }
    String::new()
}

impl SymbolIndex {
    /** Index only synchronized source. Never read files or walk function bodies. */
    pub fn build(text: &str, tree: Option<&Tree>) -> Self {
        let mut index = Self::default();
        if let Some(tree) = tree {
            let mut stack = vec![tree.root_node()];
            let mut visited = 0;
            while let Some(node) = stack.pop() {
                visited += 1;
                if visited > 4096 || index.symbols.len() >= 128 {
                    break;
                }
                let kind = node.kind();
                if matches!(
                    kind,
                    "import_statement"
                        | "import_from_statement"
                        | "use_declaration"
                        | "extern_crate_declaration"
                ) {
                    let fragment = head(&text[node.byte_range()], 512);
                    if index.headers.len() + fragment.len() < 2048 {
                        index.headers.push_str(fragment);
                        index.headers.push('\n');
                    }
                    continue;
                }
                if symbol_kind(kind) {
                    if let Some(name) = node.child_by_field_name("name") {
                        let end = if type_kind(kind) {
                            node.end_byte()
                        } else {
                            node.child_by_field_name("body")
                                .map_or(node.end_byte(), |body| body.start_byte())
                        };
                        index.symbols.push(Symbol {
                            name: head(&text[name.byte_range()], 128).to_string(),
                            owner: owner(node, text),
                            signature: head(
                                text[node.start_byte()..end].trim(),
                                if type_kind(kind) { 600 } else { 300 },
                            )
                            .to_string(),
                            start: node.start_byte(),
                            end: node.end_byte(),
                        });
                    }
                    if !matches!(
                        kind,
                        "class_definition" | "class_declaration" | "trait_item"
                    ) {
                        continue;
                    }
                }
                let mut walk = node.walk();
                let children: Vec<_> = node
                    .named_children(&mut walk)
                    .filter(|child| {
                        !matches!(child.kind(), "comment" | "line_comment" | "block_comment")
                    })
                    .take(256)
                    .collect();
                stack.extend(children.into_iter().rev());
            }
        } else {
            // Import/package context also works for languages without a grammar.
            for line in head(text, 16_384).lines().take(128) {
                let trimmed = line.trim_start();
                if [
                    "import ",
                    "from ",
                    "use ",
                    "using ",
                    "package ",
                    "#include ",
                ]
                .iter()
                .any(|prefix| trimmed.starts_with(prefix))
                {
                    let fragment = head(line, 512);
                    if index.headers.len() + fragment.len() < 2048 {
                        index.headers.push_str(fragment);
                        index.headers.push('\n');
                    }
                }
            }
        }
        index
    }
}
