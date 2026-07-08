"""Proxima — Web Scrape Patch.
Monkey-patches requests.Response to auto-convert HTML content to Markdown.
"""

import re as _re


def _strip_noise_tags(html: str) -> str:
    """Removes script, style, and navigation elements from HTML."""
    noise_tags = [
        "script", "style", "noscript", "svg", "nav", "footer",
        "iframe", "object", "embed",
    ]
    for tag in noise_tags:
        html = _re.sub(
            rf"<{tag}[\s>].*?</{tag}>",
            "",
            html,
            flags=_re.DOTALL | _re.IGNORECASE,
        )
        html = _re.sub(
            rf"<{tag}\s[^>]*/\s*>",
            "",
            html,
            flags=_re.IGNORECASE,
        )
    return html


def _html_to_markdown(html: str) -> str:
    """Converts HTML string to Markdown using html2text."""
    import html2text

    html = _strip_noise_tags(html)

    converter = html2text.HTML2Text()
    converter.ignore_links = False
    converter.ignore_images = True
    converter.ignore_emphasis = False
    converter.body_width = 0
    converter.skip_internal_links = True
    converter.inline_links = True
    converter.protect_links = True
    converter.ignore_tables = False
    converter.single_line_break = True
    converter.unicode_snob = True
    converter.decode_errors = "replace"

    markdown = converter.handle(html)
    markdown = _re.sub(r"\n{3,}", "\n\n", markdown)
    return markdown.strip()


def install_web_scrape_patch():
    """Monkey-patches requests.Response.text to auto-convert HTML responses."""
    try:
        import requests
        import html2text  # noqa: F401
    except ImportError:
        return

    _OrigResponse = requests.models.Response
    _original_text_fget = _OrigResponse.text.fget

    if getattr(_OrigResponse, "_proxima_scrape_patched", False):
        return

    def _smart_text(self):
        """Returns markdown for HTML responses, original text otherwise."""
        original = _original_text_fget(self)

        content_type = self.headers.get("Content-Type", "")
        if "text/html" not in content_type.lower():
            return original

        cached = getattr(self, "_proxima_markdown", None)
        if cached is not None:
            return cached

        try:
            md = _html_to_markdown(original)
            self._proxima_raw_html = original
            self._proxima_markdown = md
            return md
        except Exception:
            return original

    def _raw_html_getter(self):
        """Gets original unmodified HTML text."""
        if hasattr(self, "_proxima_raw_html"):
            return self._proxima_raw_html
        return _original_text_fget(self)

    _OrigResponse.text = property(_smart_text)
    _OrigResponse.raw_html = property(_raw_html_getter)
    _OrigResponse._proxima_scrape_patched = True
