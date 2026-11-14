use std::io::{Error, ErrorKind, Result};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const MAX_BODY: usize = 8 * 1024 * 1024;
const MAX_HEADERS: usize = 8192;

pub async fn read_frame<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Option<Vec<u8>>> {
    let mut headers = 0;
    let mut length = None;
    loop {
        let mut line = Vec::new();
        // Bound each read even if a peer never sends a newline.
        let n = reader
            .take((MAX_HEADERS - headers + 1) as u64)
            .read_until(b'\n', &mut line)
            .await?;
        if n == 0 && headers == 0 {
            return Ok(None);
        }
        headers += n;
        if n == 0 || headers > MAX_HEADERS {
            return Err(Error::new(
                ErrorKind::InvalidData,
                "invalid or oversized headers",
            ));
        }
        if line == b"\r\n" {
            break;
        }
        let header =
            std::str::from_utf8(&line).map_err(|e| Error::new(ErrorKind::InvalidData, e))?;
        let (key, value) = header
            .split_once(':')
            .ok_or_else(|| Error::new(ErrorKind::InvalidData, "invalid header"))?;
        if key.eq_ignore_ascii_case("Content-Length") {
            if length.is_some() {
                return Err(Error::new(ErrorKind::InvalidData, "duplicate length"));
            }
            length = Some(
                value
                    .trim()
                    .parse::<usize>()
                    .map_err(|e| Error::new(ErrorKind::InvalidData, e))?,
            );
        }
    }
    let length = length
        .filter(|n| *n <= MAX_BODY)
        .ok_or_else(|| Error::new(ErrorKind::InvalidData, "missing or oversized length"))?;
    let mut body = vec![0; length];
    reader.read_exact(&mut body).await?;
    Ok(Some(body))
}

pub async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    value: &serde_json::Value,
) -> Result<()> {
    let body = serde_json::to_vec(value)?;
    writer
        .write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
        .await?;
    writer.write_all(&body).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[tokio::test]
    async fn round_trip_unicode_and_consecutive_frames() {
        let first = serde_json::json!({"text":"Türkçe 😀"});
        let second = serde_json::json!({"id":2});
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &first).await.unwrap();
        write_frame(&mut bytes, &second).await.unwrap();
        // One-byte buffer forces fragmentation across headers and UTF-8 bytes.
        let mut reader = BufReader::with_capacity(1, bytes.as_slice());
        for expected in [first, second] {
            let body = read_frame(&mut reader).await.unwrap().unwrap();
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                expected
            );
        }
        assert!(read_frame(&mut reader).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn rejects_invalid_and_truncated_frames() {
        for bytes in [
            b"Content-Length: 8388609\r\n\r\n".as_slice(),
            b"Content-Length: 1\r\nContent-Length: 1\r\n\r\nx",
            b"Content-Type: application/json\r\n\r\n",
            b"Content-Length: 2\r\n\r\nx",
            b"Content-Length: abc\r\n\r\n",
        ] {
            assert!(read_frame(&mut BufReader::new(bytes)).await.is_err());
        }
        let oversized = vec![b'x'; MAX_HEADERS + 1];
        assert!(
            read_frame(&mut BufReader::new(oversized.as_slice()))
                .await
                .is_err()
        );
    }
}
