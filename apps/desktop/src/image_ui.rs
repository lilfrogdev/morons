use gpui::{prelude::*, *};
use morons_desktop::generated_images::GeneratedImage;
use std::{io::Write, path::Path, sync::Arc};

pub fn render_image(image: &GeneratedImage, expanded: bool) -> impl IntoElement {
    div().flex().flex_col().gap_2()
        .child(div().font_weight(FontWeight::SEMIBOLD).child(image.title.clone()))
        .child(div().text_xs().text_color(rgb(0x626772)).child(format!("{} · {}", image.model,
            match image.status.as_str() {
                "generating" => "Generating image…",
                "completed" => "Generated PNG",
                "uncertain" => "Completion unknown",
                _ => "Generation failed",
            })))
        .when_some(image.bytes.clone(), |d, bytes| d.child(
            img(Arc::new(Image::from_bytes(ImageFormat::Png, bytes.as_ref().clone())))
                .object_fit(ObjectFit::Contain).w_full()
                .max_h(px(if expanded { 640. } else { 260. }))
        ))
        .when(image.status == "completed" && image.bytes.is_none(), |d| d.child(
            div().text_sm().child("Image saved on the server. Load its preview to open or save it.")))
        .when_some(image.error.clone(), |d, error| d.child(
            div().text_sm().text_color(rgb(0xA04438)).child(error)))
        .child(div().text_xs().text_color(rgb(0x626772)).child(
            if let Some(usage) = &image.usage {
                format!("API usage: {} input · {} output tokens · cost unavailable",
                    usage.get("input_tokens").and_then(|v| v.as_u64()).map(|v| v.to_string()).unwrap_or_else(|| "unknown".into()),
                    usage.get("output_tokens").and_then(|v| v.as_u64()).map(|v| v.to_string()).unwrap_or_else(|| "unknown".into()))
            } else { "API usage and cost unavailable".into() }))
}

pub fn save_png(path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    if path.extension().is_none_or(|extension| !extension.eq_ignore_ascii_case("png")) {
        return Err("Choose a filename ending in .png");
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| if error.kind() == std::io::ErrorKind::AlreadyExists {
        "Choose a new filename to save the image"
    } else { "Cannot save image to the selected path" })?;
    if file.write_all(bytes).and_then(|_| file.sync_all()).is_err() {
        drop(file);
        let _ = std::fs::remove_file(path);
        return Err("Could not finish saving image");
    }
    Ok(())
}
