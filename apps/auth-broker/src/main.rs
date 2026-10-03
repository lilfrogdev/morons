use morons_auth_broker::{MAX_BYTES, Response};
use std::io::{Read, Write};
use zeroize::{Zeroize, Zeroizing};
fn main() {
    // This helper has no autonomous startup or ambient credential lookup. It
    // processes exactly one bounded request from a dedicated parent pipe.
    let mut input = Zeroizing::new(Vec::new());
    let result = std::io::stdin()
        .take((MAX_BYTES + 1025) as u64)
        .read_to_end(&mut input);
    #[cfg(target_os = "macos")]
    let mut reply = if result.is_ok() {
        morons_auth_broker::execute(&mut morons_auth_broker::MacKeychain, &input)
    } else {
        Response::Failed
    };
    #[cfg(not(target_os = "macos"))]
    let mut reply = {
        let _ = result;
        Response::Failed
    };
    // stdout is a dedicated broker pipe, NEVER a log or app transcript. stderr
    // stays empty; platform/library errors are reduced to a fixed status.
    let output = serde_json::to_vec(&reply).map(Zeroizing::new);
    if let Ok(output) = output {
        let _ = std::io::stdout().write_all(&output);
    }
    if let Response::Found { payload } = &mut reply {
        payload.zeroize();
    }
}
