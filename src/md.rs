use pulldown_cmark::{html, CowStr, Event, Options, Parser, Tag};

/// Markdown to HTML for the preview and viewer. Raw HTML is shown as text and
/// only http(s)/mailto or relative urls survive. Relative urls are prefixed:
/// images with `img_base` (raw files), links with `link_base` (the viewer).
pub fn render(text: &str, img_base: Option<&str>, link_base: Option<&str>) -> String {
    let opts = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES;
    let events = Parser::new_ext(text, opts).map(|ev| match ev {
        Event::Html(h) | Event::InlineHtml(h) => Event::Text(h),
        Event::Start(Tag::Link { link_type, dest_url, title, id }) => {
            Event::Start(Tag::Link { link_type, dest_url: fix(dest_url, link_base, false), title, id })
        }
        Event::Start(Tag::Image { link_type, dest_url, title, id }) => {
            Event::Start(Tag::Image { link_type, dest_url: fix(dest_url, img_base, true), title, id })
        }
        e => e,
    });
    let mut out = String::new();
    html::push_html(&mut out, events);
    out
}

fn fix<'a>(url: CowStr<'a>, base: Option<&str>, image: bool) -> CowStr<'a> {
    let u = url.trim();
    if let Some((scheme, _)) = u.split_once(':') {
        if !scheme.contains(['/', '?', '#']) {
            let s = scheme.to_ascii_lowercase();
            let ok = matches!(s.as_str(), "http" | "https") || (s == "mailto" && !image);
            return if ok { url } else { CowStr::Borrowed("#") };
        }
    }
    if u.is_empty() || u.starts_with(['#', '/']) {
        return url;
    }
    match base {
        Some(b) => CowStr::from(format!("{b}{u}")),
        None => url,
    }
}

#[cfg(test)]
mod tests {
    use super::render;

    #[test]
    fn sanitizes() {
        let h = render("<script>x</script>\n\n[a](javascript:alert(1)) ![i](p.png) [b](c.md)", Some("/raw/"), Some("/view/"));
        assert!(!h.contains("<script>"), "{h}");
        assert!(h.contains("href=\"#\""), "{h}");
        assert!(h.contains("src=\"/raw/p.png\""), "{h}");
        assert!(h.contains("href=\"/view/c.md\""), "{h}");
    }
}
