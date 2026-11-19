//! The GATT surface exposed to the website.
//!
//! The three UUIDs below are mirrored in `web/src/protocol.js` — change them
//! together (see `CONTRIBUTING.md`).

use heapless::Vec;
use trouble_host::prelude::*;

/// Primary service. Mirrored in `web/src/protocol.js` as `SERVICE_UUID`.
pub const SERVICE_UUID: &str = "937312e0-2354-11eb-9f10-fbc30a62cf38";
/// Commands in, responses out. Mirrored as `CONTROL_UUID`.
pub const CONTROL_UUID: &str = "937312e1-2354-11eb-9f10-fbc30a62cf38";
/// Asynchronous state pushes. Mirrored as `STATUS_UUID`.
pub const STATUS_UUID: &str = "937312e2-2354-11eb-9f10-fbc30a62cf38";

/// Simultaneous BLE centrals we accept.
pub const CONNECTIONS_MAX: usize = 1;
/// L2CAP channels per connection (signal + ATT).
pub const L2CAP_CHANNELS_MAX: usize = 2;

/// Attribute value capacity — ATT_MTU (255) minus the 3-byte opcode/handle.
pub const MAX_VALUE: usize = 240;

#[gatt_server(connections_max = CONNECTIONS_MAX, attribute_table_size = 64)]
pub struct Server {
    pub remote: RemoteService,
}

#[gatt_service(uuid = "937312e0-2354-11eb-9f10-fbc30a62cf38")]
pub struct RemoteService {
    /// Write a `\n`-terminated command here; read/notify returns `\n`-terminated responses.
    #[characteristic(uuid = "937312e1-2354-11eb-9f10-fbc30a62cf38", read, write, notify)]
    pub control: Vec<u8, MAX_VALUE>,

    /// Unsolicited state pushes (Wi-Fi events, scan results, LED changes).
    #[characteristic(uuid = "937312e2-2354-11eb-9f10-fbc30a62cf38", read, notify)]
    pub status: Vec<u8, MAX_VALUE>,
}
