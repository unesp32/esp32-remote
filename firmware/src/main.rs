//! ESP32-S3 remote-control firmware.
//!
//! Two transports, one protocol:
//!
//! * **BLE GATT** ([`gatt::Server`]) — the website connects over Web Bluetooth
//!   and exchanges newline-delimited ASCII ([`protocol`]).
//! * **Wi-Fi** — scanned and joined on command, so the site can provision the
//!   device with a network from anywhere.
//!
//! The GATT `control` characteristic is the single entry point: write a
//! command line, get one or more response lines back as notifications.

#![no_std]
#![no_main]

mod gatt;
mod protocol;

use core::cmp::min;
use core::fmt::Write as _;
use core::sync::atomic::{AtomicU8, Ordering};

use embassy_executor::Spawner;
use embassy_futures::join::join;
use embassy_futures::select::{select, Either};
use embassy_net::{Runner, Stack as NetStack, StackResources};
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::channel::Channel;
use embassy_time::{Duration, Timer, with_timeout};
use esp_alloc as _;
use esp_backtrace as _;
use esp_hal::{
    clock::CpuClock,
    gpio::{AnyPin, Level, Output, OutputConfig},
    interrupt::software::SoftwareInterruptControl,
    ram, rng::Rng,
    timer::timg::TimerGroup,
};
use heapless::Vec;
use esp_radio::{
    ble::controller::BleConnector,
    wifi::{
        Config, ControllerConfig, Interface, WifiController, scan::ScanConfig,
        sta::StationConfig,
    },
};
use log::{info, warn};
use trouble_host::prelude::*;

use gatt::{CONNECTIONS_MAX, L2CAP_CHANNELS_MAX, Server};
use protocol::{Cmd, Line};

esp_bootloader_esp_idf::esp_app_desc!();

/// BLE local name — the website filters on this prefix.
const DEVICE_NAME: &str = "esp32-remote";
const FW_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Default status LED (GPIO48 = RGB LED on ESP32-S3-DevKitC-1).
const DEFAULT_LED_PIN: u8 = 48;
/// How many distinct GPIOs may be driven at once.
const MAX_PINS: usize = 8;

/// Commands: BLE task → Wi-Fi task.
static CMD_CH: Channel<CriticalSectionRawMutex, Cmd, 4> = Channel::new();
/// Responses: Wi-Fi task → BLE task (one line each).
static RESP_CH: Channel<CriticalSectionRawMutex, Line, 32> = Channel::new();
/// LED state, so the Wi-Fi task can include it in `STATUS`.
static LED_STATE: AtomicU8 = AtomicU8::new(0);

/// `StaticCell` helper — nightly-friendly alternative to `Box::leak`.
macro_rules! mk_static {
    ($t:ty, $val:expr) => {{
        static STATIC_CELL: static_cell::StaticCell<$t> = static_cell::StaticCell::new();
        #[deny(unused_attributes)]
        let x = STATIC_CELL.uninit().write(($val));
        x
    }};
}

#[esp_rtos::main]
async fn main(spawner: Spawner) -> ! {
    esp_println::logger::init_logger_from_env();

    let peripherals = esp_hal::init(esp_hal::Config::default().with_cpu_clock(CpuClock::max()));

    // Wi-Fi + BLE coexistence is RAM hungry.
    esp_alloc::heap_allocator!(#[ram(reclaimed)] size: 64 * 1024);
    esp_alloc::heap_allocator!(size: 64 * 1024);

    let timg0 = TimerGroup::new(peripherals.TIMG0);
    let sw_int = SoftwareInterruptControl::new(peripherals.SW_INTERRUPT);
    esp_rtos::start(timg0.timer0, sw_int.software_interrupt0);

    // --- Bluetooth -------------------------------------------------------
    let connector = BleConnector::new(peripherals.BT, Default::default()).unwrap();
    let ble_controller: ExternalController<BleConnector<'static>, 1> =
        ExternalController::new(connector);

    // --- Wi-Fi -----------------------------------------------------------
    let (wifi_controller, interfaces) =
        esp_radio::wifi::new(peripherals.WIFI, ControllerConfig::default()).unwrap();

    let mac = interfaces.station.mac_address();
    info!(
        "device mac = {:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
        mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]
    );

    let rng = Rng::new();
    let seed = (rng.random() as u64) << 32 | rng.random() as u64;

    let (net_stack, net_runner) = embassy_net::new(
        interfaces.station,
        embassy_net::Config::dhcpv4(Default::default()),
        mk_static!(StackResources<3>, StackResources::<3>::new()),
        seed,
    );

    spawner.spawn(ble_task(ble_controller, mac).unwrap());
    spawner.spawn(wifi_task(wifi_controller, net_stack).unwrap());
    spawner.spawn(net_task(net_runner).unwrap());

    info!("esp32-remote firmware {} on {}", FW_VERSION, esp_hal::chip!());

    loop {
        Timer::after(Duration::from_secs(3600)).await;
    }
}

// ---------------------------------------------------------------------------
// BLE
// ---------------------------------------------------------------------------

#[embassy_executor::task]
async fn ble_task(controller: ExternalController<BleConnector<'static>, 1>, mac: [u8; 6]) {
    // Static-random address, derived from the factory MAC so every board is
    // unique (two MSBs forced to `11` as the BLE spec requires).
    let address = Address::random([mac[0] | 0xC0, mac[1], mac[2], mac[3], mac[4], mac[5]]);
    info!("BLE address = {:?}", address);

    let mut resources: HostResources<DefaultPacketPool, CONNECTIONS_MAX, L2CAP_CHANNELS_MAX> =
        HostResources::new();
    let stack = trouble_host::new(controller, &mut resources).set_random_address(address);

    let Host {
        mut peripheral,
        mut runner,
        ..
    } = stack.build();

    let server = Server::new_with_config(GapConfig::Peripheral(PeripheralConfig {
        name: DEVICE_NAME,
        appearance: &appearance::power_device::GENERIC_POWER_DEVICE,
    }))
    .unwrap();

    let mut adv_data = [0u8; 31];
    let adv_len = AdStructure::encode_slice(
        &[
            AdStructure::Flags(LE_GENERAL_DISCOVERABLE | BR_EDR_NOT_SUPPORTED),
            AdStructure::CompleteLocalName(DEVICE_NAME.as_bytes()),
        ],
        &mut adv_data[..],
    )
    .unwrap();

    // GPIO outputs we have already claimed, keyed by pin number.
    let mut outputs: Vec<(u8, Output<'static>), MAX_PINS> = Vec::new();

    let _ = join(
        runner.run(),
        async {
            loop {
                let params = AdvertisementParameters::default();
                let advertised = peripheral
                    .advertise(
                        &params,
                        Advertisement::ConnectableScannableUndirected {
                            adv_data: &adv_data[..adv_len],
                            scan_data: &[],
                        },
                    )
                    .await;

                let adv = match advertised {
                    Ok(adv) => adv,
                    Err(e) => {
                        warn!("[ble] advertise error: {:?}", e);
                        Timer::after(Duration::from_secs(1)).await;
                        continue;
                    }
                };

                let accepted = adv.accept().await;
                let conn = match accepted {
                    Ok(conn) => match conn.with_attribute_server(&server) {
                        Ok(conn) => conn,
                        Err(e) => {
                            warn!("[ble] attribute server error: {:?}", e);
                            continue;
                        }
                    },
                    Err(e) => {
                        warn!("[ble] accept error: {:?}", e);
                        continue;
                    }
                };

                info!("[ble] central connected");
                connection_loop(&server, &conn, &mut outputs, mac).await;
                info!("[ble] central disconnected");
            }
        },
    )
    .await;
}

/// Serve one BLE connection until it drops.
///
/// `conn.next()` is cancel-safe (`poll_receive`), as is channel `receive`, so
/// `select`-ing the two is sound.
async fn connection_loop(
    server: &Server<'_>,
    conn: &GattConnection<'_, '_, DefaultPacketPool>,
    outputs: &mut Vec<(u8, Output<'static>), MAX_PINS>,
    mac: [u8; 6],
) {
    let resp_rx = RESP_CH.receiver();
    let mut raw = [0u8; protocol::MAX_COMMAND];

    loop {
        match select(conn.next(), resp_rx.receive()).await {
            Either::First(evt) => match evt {
                GattConnectionEvent::Disconnected { reason } => {
                    info!("[ble] disconnected: {:?}", reason);
                    break;
                }
                GattConnectionEvent::Gatt { event } => {
                    // Copy the payload out before `accept` consumes the event.
                    let mut len = 0usize;
                    if let GattEvent::Write(write) = &event {
                        let data = write.data();
                        len = min(data.len(), raw.len());
                        raw[..len].copy_from_slice(&data[..len]);
                    }

                    // The client waits for this reply — never skip it.
                    match event.accept() {
                        Ok(reply) => reply.send().await,
                        Err(e) => warn!("[ble] ATT accept error: {:?}", e),
                    }

                    if len > 0 {
                        match protocol::parse(&raw[..len]) {
                            Ok(cmd) => dispatch(cmd, server, conn, outputs, mac).await,
                            Err(e) => notify(server, conn, &e).await,
                        }
                    }
                }
                _ => {}
            },
            Either::Second(line) => notify(server, conn, &line).await,
        }
    }
}

/// Run one parsed command: handle it locally, or hand it to the Wi-Fi task.
async fn dispatch(
    cmd: Cmd,
    server: &Server<'_>,
    conn: &GattConnection<'_, '_, DefaultPacketPool>,
    outputs: &mut Vec<(u8, Output<'static>), MAX_PINS>,
    mac: [u8; 6],
) {
    match cmd {
        Cmd::Ping => notify(server, conn, &Line::from_static("OK PONG")).await,
        Cmd::Info => {
            let mut line = Line::new();
            let _ = write!(
                line,
                "OK INFO name={} chip={} fw={} mac={:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
                DEVICE_NAME,
                esp_hal::chip!(),
                FW_VERSION,
                mac[0],
                mac[1],
                mac[2],
                mac[3],
                mac[4],
                mac[5]
            );
            notify(server, conn, &line).await;
        }
        Cmd::Led(action) => {
            let current = LED_STATE.load(Ordering::Relaxed);
            let next = match action {
                0 => 0,
                1 => 1,
                _ => if current == 0 { 1 } else { 0 },
            };
            match drive_pin(outputs, DEFAULT_LED_PIN, next) {
                Ok(()) => {
                    LED_STATE.store(next, Ordering::Relaxed);
                    notify(
                        server,
                        conn,
                        &Line::from_static(if next == 1 {
                            "OK LED 1"
                        } else {
                            "OK LED 0"
                        }),
                    )
                    .await;
                }
                Err(e) => notify(server, conn, &e).await,
            }
        }
        Cmd::Gpio { pin, level } => match drive_pin(outputs, pin, level) {
            Ok(()) => {
                if pin == DEFAULT_LED_PIN {
                    LED_STATE.store(level, Ordering::Relaxed);
                }
                let mut line = Line::new();
                let _ = write!(line, "OK GPIO {} {}", pin, level);
                notify(server, conn, &line).await;
            }
            Err(e) => notify(server, conn, &e).await,
        },
        // Anything that touches the radio goes to the Wi-Fi task.
        cmd @ (Cmd::Scan | Cmd::Join { .. } | Cmd::Status) => {
            if CMD_CH.sender().try_send(cmd).is_err() {
                notify(server, conn, &Line::from_static("ERR busy")).await;
            }
        }
    }
}

/// ESP32-S3 pins that are safe to drive as outputs:
/// flash (26-32), PSRAM (33-37) and USB-Serial/JTAG (19-20) are off limits,
/// and GPIO22-25 do not exist on this chip.
fn pin_available(pin: u8) -> bool {
    matches!(pin, 0..=18 | 21 | 38..=48)
}

fn drive_pin(
    outputs: &mut Vec<(u8, Output<'static>), MAX_PINS>,
    pin: u8,
    level: u8,
) -> Result<(), Line> {
    if !pin_available(pin) {
        return Err(Line::from_static(
            "ERR pin not available on ESP32-S3 (safe: 0-18, 21, 38-48)",
        ));
    }

    let idx = match outputs.iter().position(|(p, _)| *p == pin) {
        Some(idx) => idx,
        None => {
            if outputs.is_full() {
                return Err(Line::from_static("ERR too many pins in use"));
            }
            let output = Output::new(
                unsafe { AnyPin::steal(pin) },
                Level::Low,
                OutputConfig::default(),
            );
            outputs
                .push((pin, output))
                .map_err(|_| Line::from_static("ERR too many pins in use"))?;
            outputs.len() - 1
        }
    };

    if level == 1 {
        outputs[idx].1.set_high();
    } else {
        outputs[idx].1.set_low();
    }
    Ok(())
}

async fn notify(
    server: &Server<'_>,
    conn: &GattConnection<'_, '_, DefaultPacketPool>,
    line: &Line,
) {
    if server.remote.control.notify(conn, line.value()).await.is_err() {
        warn!("[ble] notify failed");
    }
}

// ---------------------------------------------------------------------------
// Wi-Fi
// ---------------------------------------------------------------------------

#[embassy_executor::task]
async fn wifi_task(mut controller: WifiController<'static>, stack: NetStack<'static>) {
    let cmd_rx = CMD_CH.receiver();
    let resp_tx = RESP_CH.sender();
    let mut current_ssid: heapless::Vec<u8, 32> = heapless::Vec::new();

    loop {
        match cmd_rx.receive().await {
            Cmd::Scan => {
                let _ = resp_tx.send(Line::from_static("OK SCAN_START")).await;
                let scanned = with_timeout(
                    Duration::from_secs(20),
                    controller.scan_async(&ScanConfig::default().with_max(15)),
                )
                .await;

                match scanned {
                    Ok(Ok(aps)) => {
                        let count = aps.len();
                        for ap in &aps {
                            let mut line = Line::new();
                            let _ = write!(
                                line,
                                "AP rssi={} auth={:?} channel={} ssid={}",
                                ap.signal_strength,
                                ap.auth_method,
                                ap.channel,
                                ap.ssid.as_str()
                            );
                            let _ = resp_tx.send(line).await;
                        }
                        let mut line = Line::new();
                        let _ = write!(line, "OK SCAN_DONE n={}", count);
                        let _ = resp_tx.send(line).await;
                    }
                    Ok(Err(e)) => {
                        let mut line = Line::from_static("ERR SCAN ");
                        let _ = write!(line, "{:?}", e);
                        let _ = resp_tx.send(line).await;
                    }
                    Err(_) => {
                        let _ = resp_tx.send(Line::from_static("ERR SCAN timeout")).await;
                    }
                }
            }

            Cmd::Join { ssid, pass } => {
                let ssid_str = match core::str::from_utf8(&ssid) {
                    Ok(s) => s,
                    Err(_) => {
                        let _ = resp_tx.send(Line::from_static("ERR JOIN ssid not UTF-8")).await;
                        continue;
                    }
                };
                let pass_str = match core::str::from_utf8(&pass) {
                    Ok(s) => s,
                    Err(_) => {
                        let _ = resp_tx.send(Line::from_static("ERR JOIN password not UTF-8")).await;
                        continue;
                    }
                };

                let wanted = Config::Station(
                    StationConfig::default()
                        .with_ssid(ssid_str)
                        .with_password(pass_str.into()),
                );

                if let Err(e) = controller.set_config(&wanted) {
                    let mut line = Line::from_static("ERR JOIN set_config ");
                    let _ = write!(line, "{:?}", e);
                    let _ = resp_tx.send(line).await;
                    continue;
                }

                let joined = with_timeout(Duration::from_secs(30), controller.connect_async()).await;
                match joined {
                    Ok(Ok(_info)) => {
                        current_ssid.clear();
                        let _ = current_ssid.extend_from_slice(&ssid);
                        let mut line = Line::from_static("OK JOIN ssid=");
                        line.push_str(ssid_str);
                        let _ = resp_tx.send(line).await;
                    }
                    Ok(Err(e)) => {
                        let mut line = Line::from_static("ERR JOIN ");
                        let _ = write!(line, "{:?}", e);
                        let _ = resp_tx.send(line).await;
                    }
                    Err(_) => {
                        let _ = resp_tx.send(Line::from_static("ERR JOIN timeout")).await;
                    }
                }
            }

            Cmd::Status => {
                let connected = controller.is_connected();
                let rssi = controller.rssi().ok();
                let address = stack.config_v4().map(|c| c.address);
                let ssid = core::str::from_utf8(&current_ssid).unwrap_or("-");

                let mut line = Line::new();
                let _ = write!(line, "OK STATUS wifi={}", if connected { "up" } else { "down" });
                match address {
                    Some(address) => {
                        let _ = write!(line, " ip={}", address);
                    }
                    None => {
                        let _ = write!(line, " ip=-");
                    }
                }
                let _ = write!(line, " ssid={}", ssid);
                match rssi {
                    Some(rssi) => {
                        let _ = write!(line, " rssi={}", rssi);
                    }
                    None => {
                        let _ = write!(line, " rssi=-");
                    }
                }
                let _ = write!(
                    line,
                    " led={}",
                    LED_STATE.load(Ordering::Relaxed)
                );
                let _ = resp_tx.send(line).await;
            }

            // Handled entirely inside the BLE task.
            _ => {}
        }
    }
}

#[embassy_executor::task]
async fn net_task(mut runner: Runner<'static, Interface<'static>>) {
    runner.run().await
}
