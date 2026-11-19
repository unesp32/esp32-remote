//! Line-based ASCII protocol shared between this firmware and the website.
//!
//! Every message is exactly one line of printable ASCII terminated by `\n`.
//! The browser side mirrors this file in `web/src/protocol.js`, and the
//! grammar is documented in `CONTRIBUTING.md` — change all three together.

use heapless::Vec;

/// Longest line we will ever send or receive.
///
/// Must fit inside an ATT value: with `default-packet-pool-mtu-255` the MTU is
/// 255, so an attribute value may be at most `255 - 3 = 252` bytes.
pub const MAX_LINE: usize = 240;

/// Largest command we accept in one GATT write.
pub const MAX_COMMAND: usize = 256;

/// A single protocol line.
#[derive(Clone, Default)]
pub struct Line(Vec<u8, MAX_LINE>);

impl Line {
    pub fn new() -> Self {
        Self(Vec::new())
    }

    /// Build a line from a literal (no allocation, no formatting).
    pub fn from_static(s: &str) -> Self {
        let mut line = Self::new();
        line.push_str(s);
        line
    }

    /// Append ASCII text, silently truncating if the line is full.
    pub fn push_str(&mut self, s: &str) {
        let _ = self.0.extend_from_slice(s.as_bytes());
    }

    pub fn bytes(&self) -> &[u8] {
        &self.0
    }

    /// Borrow the underlying buffer — this is what GATT `notify` wants.
    pub fn value(&self) -> &Vec<u8, MAX_LINE> {
        &self.0
    }
}

impl core::fmt::Write for Line {
    fn write_str(&mut self, s: &str) -> core::fmt::Result {
        self.0
            .extend_from_slice(s.as_bytes())
            .map_err(|_| core::fmt::Error)
    }
}

/// `ERR <detail>` response.
pub fn err(detail: &str) -> Line {
    let mut line = Line::from_static("ERR ");
    line.push_str(detail);
    line
}

/// `OK <detail>` response.
pub fn ok(detail: &str) -> Line {
    let mut line = Line::from_static("OK ");
    line.push_str(detail);
    line
}

/// A command received from the website over the `control` characteristic.
#[derive(Clone)]
pub enum Cmd {
    Ping,
    Info,
    Scan,
    Status,
    /// `JOIN ssid=<ssid> pass=<password>`
    Join {
        ssid: Vec<u8, 32>,
        pass: Vec<u8, 64>,
    },
    /// `LED ON|OFF|TOGGLE` → 1 = on, 0 = off, 2 = toggle.
    Led(u8),
    /// `GPIO <pin> <0|1>`
    Gpio {
        pin: u8,
        level: u8,
    },
}

/// Parse one raw GATT write into a [`Cmd`].
pub fn parse(raw: &[u8]) -> Result<Cmd, Line> {
    let text = core::str::from_utf8(raw).map_err(|_| err("command is not UTF-8"))?;
    let text = text.trim();
    if text.is_empty() {
        return Err(err("empty command"));
    }

    let (verb, rest) = match text.find(' ') {
        Some(i) => (&text[..i], text[i + 1..].trim_start()),
        None => (text, ""),
    };

    match verb {
        "PING" => Ok(Cmd::Ping),
        "INFO" => Ok(Cmd::Info),
        "SCAN" => Ok(Cmd::Scan),
        "STATUS" => Ok(Cmd::Status),
        "LED" => match rest {
            "ON" | "1" => Ok(Cmd::Led(1)),
            "OFF" | "0" => Ok(Cmd::Led(0)),
            "TOGGLE" => Ok(Cmd::Led(2)),
            _ => Err(err("LED ON|OFF|TOGGLE")),
        },
        "GPIO" => {
            let mut parts = rest.split_whitespace();
            let pin = parts
                .next()
                .and_then(|v| v.parse::<u8>().ok())
                .ok_or_else(|| err("GPIO <pin> <0|1>"))?;
            let level = match parts.next() {
                Some("0") | Some("OFF") => 0,
                Some("1") | Some("ON") => 1,
                _ => return Err(err("GPIO <pin> <0|1>")),
            };
            Ok(Cmd::Gpio { pin, level })
        }
        "JOIN" => parse_join(rest),
        other => {
            let mut line = Line::from_static("ERR unknown command ");
            line.push_str(other);
            Err(line)
        }
    }
}

/// `JOIN ssid=<ssid> pass=<password>`.
///
/// The SSID is everything up to the *first* ` pass=`, so SSIDs may contain
/// spaces (but must not themselves contain ` pass=`).
fn parse_join(rest: &str) -> Result<Cmd, Line> {
    const SYNTAX: &str = "JOIN ssid=<ssid> pass=<password>";

    let split = rest.find(" pass=").ok_or_else(|| err(SYNTAX))?;
    let ssid_part = &rest[..split];
    let pass_part = &rest[split + " pass=".len()..];
    let ssid_str = ssid_part.strip_prefix("ssid=").ok_or_else(|| err(SYNTAX))?;

    let ssid_bytes = ssid_str.as_bytes();
    if ssid_bytes.is_empty() || ssid_bytes.len() > 32 {
        return Err(err("JOIN ssid must be 1..=32 bytes"));
    }
    if pass_part.len() > 64 {
        return Err(err("JOIN password must be <= 64 bytes"));
    }

    let mut ssid = Vec::new();
    ssid.extend_from_slice(ssid_bytes)
        .map_err(|_| err("JOIN ssid too long"))?;
    let mut pass = Vec::new();
    pass.extend_from_slice(pass_part.as_bytes())
        .map_err(|_| err("JOIN password too long"))?;

    Ok(Cmd::Join { ssid, pass })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_str(s: &str) -> Result<Cmd, Line> {
        parse(s.as_bytes())
    }

    #[test]
    fn verbs() {
        assert!(matches!(parse_str("PING"), Ok(Cmd::Ping)));
        assert!(matches!(parse_str("INFO\n"), Ok(Cmd::Info)));
        assert!(matches!(parse_str("SCAN"), Ok(Cmd::Scan)));
        assert!(matches!(parse_str("STATUS"), Ok(Cmd::Status)));
        assert!(matches!(parse_str("LED ON"), Ok(Cmd::Led(1))));
        assert!(matches!(parse_str("LED TOGGLE"), Ok(Cmd::Led(2))));
        assert!(matches!(
            parse_str("GPIO 48 1"),
            Ok(Cmd::Gpio { pin: 48, level: 1 })
        ));
        assert!(parse_str("NOPE").is_err());
    }

    #[test]
    fn join_roundtrip() {
        match parse_str("JOIN ssid=My Home WiFi pass=hunter2 hunter2") {
            Ok(Cmd::Join { ssid, pass }) => {
                assert_eq!(&ssid[..], b"My Home WiFi");
                assert_eq!(&pass[..], b"hunter2 hunter2");
            }
            other => panic!("unexpected: {:?}", other.err().map(|l| l.bytes())),
        }
        assert!(parse_str("JOIN ssid=net pass=").is_ok());
        assert!(parse_str("JOIN ssid= pass=x").is_err());
        assert!(parse_str("JOIN ssid=net").is_err());
    }

    #[test]
    fn line_truncates_instead_of_panicking() {
        let mut line = Line::new();
        line.push_str(&"x".repeat(500));
        assert_eq!(line.bytes().len(), MAX_LINE);
    }
}
