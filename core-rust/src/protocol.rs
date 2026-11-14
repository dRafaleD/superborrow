use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub uri: String,
    pub language_id: String,
    pub version: u32,
    pub text: String,
}

#[derive(Deserialize)]
pub struct Position {
    pub line: usize,
    pub character: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Local,
    Ide,
    Hybrid,
}

#[derive(Deserialize)]
pub struct Completion {
    pub uri: String,
    pub version: u32,
    pub position: Position,
    pub mode: Mode,
}

/// Convert a VS Code UTF-16 position without splitting a surrogate pair.
pub fn offset(text: &str, position: &Position) -> Option<usize> {
    let start = if position.line == 0 {
        0
    } else {
        text.match_indices('\n').nth(position.line - 1)?.0 + 1
    };
    let line = text[start..].split('\n').next()?.trim_end_matches('\r');
    let mut units = 0;
    for (byte, ch) in line.char_indices() {
        if units == position.character {
            return Some(start + byte);
        }
        units += ch.len_utf16();
    }
    (units == position.character).then_some(start + line.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf16_and_crlf_positions() {
        let text = "a😀\r\nb\n";
        assert_eq!(
            offset(
                text,
                &Position {
                    line: 0,
                    character: 3
                }
            ),
            Some(5)
        );
        assert_eq!(
            offset(
                text,
                &Position {
                    line: 0,
                    character: 2
                }
            ),
            None
        );
        assert_eq!(
            offset(
                text,
                &Position {
                    line: 1,
                    character: 1
                }
            ),
            Some(8)
        );
        assert_eq!(
            offset(
                text,
                &Position {
                    line: 2,
                    character: 0
                }
            ),
            Some(9)
        );
    }
}
