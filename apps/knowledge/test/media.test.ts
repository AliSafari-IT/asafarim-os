import { describe, expect, it } from "vitest";
import { mediaAssetIds, parseDoc } from "@/lib/doc";
import {
  checkImageUrl,
  checkSvg,
  checkUploadRequest,
  cleanFilename,
  parseVideoUrl,
  sniffMatches,
  svgDataUrl,
  videoEmbedUrl,
} from "@/lib/media/validate";
import { mediaConfigFromEnv } from "@/lib/media/store";

const ID = "3f2a6c1e-8b4d-4e2f-9a1b-0c3d5e7f9a1b";
const parse = (...content: object[]) => parseDoc({ type: "doc", content });

describe("media in the document (#359)", () => {
  it("keeps an image only with alt text, and its caption", () => {
    const r = parse({ type: "image", attrs: { asset: ID, alt: "  A cat  ", caption: "Our cat", onload: "x" } });
    expect(r.ok && r.doc.content[0]).toEqual({ type: "image", attrs: { asset: ID, alt: "A cat", caption: "Our cat" } });
    expect(r.ok && r.text).toBe("A cat\nOur cat");
    expect(parse({ type: "image", attrs: { asset: ID, alt: "   " } })).toEqual({
      ok: false,
      error: "image_alt_required",
    });
    expect(parse({ type: "image", attrs: { asset: "../../etc/passwd", alt: "x" } })).toEqual({
      ok: false,
      error: "media_invalid",
    });
    expect(parse({ type: "attachment", attrs: { asset: ID } })).toEqual({
      ok: false,
      error: "attachment_label_required",
    });
  });

  it("stores a video as a provider and a checked id, never a URL or HTML", () => {
    const r = parse({ type: "video", attrs: { provider: "youtube", videoId: "dQw4w9WgXcQ", title: "Demo", src: "x" } });
    expect(r.ok && r.doc.content[0]).toEqual({
      type: "video",
      attrs: { provider: "youtube", videoId: "dQw4w9WgXcQ", title: "Demo" },
    });
    for (const attrs of [
      { provider: "youtube", videoId: 'dQw4w9WgXcQ"><script>', title: "x" },
      { provider: "dailymotion", videoId: "x7tgad0", title: "x" },
      { provider: "vimeo", videoId: "javascript:alert(1)", title: "x" },
    ]) {
      expect(parse({ type: "video", attrs })).toEqual({ ok: false, error: "video_invalid" });
    }
    expect(parse({ type: "video", attrs: { provider: "vimeo", videoId: "76979871" } })).toEqual({
      ok: false,
      error: "video_title_required",
    });
  });

  it("rejects arbitrary iframe or embed HTML in any form", () => {
    for (const node of [
      { type: "iframe", attrs: { src: "https://evil.example" } },
      { type: "embed", attrs: { src: "https://evil.example" } },
      { type: "html", attrs: { html: "<iframe src=x></iframe>" } },
    ]) {
      expect(parse(node)).toEqual({ ok: false, error: "doc_invalid" });
    }
    expect(parseVideoUrl('<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>')).toBeNull();
  });

  it("lists the assets a document uses, once each", () => {
    const r = parse(
      { type: "image", attrs: { asset: ID, alt: "a" } },
      { type: "blockquote", content: [{ type: "attachment", attrs: { asset: ID, label: "b" } }] },
    );
    expect(r.ok && mediaAssetIds(r.doc)).toEqual([ID]);
  });
});

describe("video addresses (#359)", () => {
  it("accepts YouTube and Vimeo addresses and nothing else", () => {
    const yt = { provider: "youtube", id: "dQw4w9WgXcQ" };
    expect(parseVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42")).toEqual(yt);
    expect(parseVideoUrl("https://youtu.be/dQw4w9WgXcQ")).toEqual(yt);
    expect(parseVideoUrl("https://m.youtube.com/shorts/dQw4w9WgXcQ")).toEqual(yt);
    expect(parseVideoUrl("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ")).toEqual(yt);
    expect(parseVideoUrl("https://vimeo.com/76979871")).toEqual({ provider: "vimeo", id: "76979871" });
    expect(parseVideoUrl("https://player.vimeo.com/video/76979871")).toEqual({ provider: "vimeo", id: "76979871" });
    for (const bad of [
      "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
      "https://evil.example/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=short",
      "https://www.youtube.com/playlist?list=PL123",
      "https://user:pw@youtube.com/watch?v=dQw4w9WgXcQ",
      "javascript:alert(1)",
      "https://vimeo.com/channels/staffpicks",
    ]) {
      expect(parseVideoUrl(bad), bad).toBeNull();
    }
  });

  it("builds the player address itself, in privacy mode", () => {
    expect(videoEmbedUrl("youtube", "dQw4w9WgXcQ")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0",
    );
    expect(videoEmbedUrl("vimeo", "76979871")).toBe("https://player.vimeo.com/video/76979871?autoplay=1&dnt=1");
    expect(() => videoEmbedUrl("youtube", "x/../y")).toThrow();
  });
});

describe("uploads (#359)", () => {
  it("allows a short list of types, each up to its size", () => {
    expect(checkUploadRequest({ contentType: "IMAGE/PNG", size: 1000, filename: "C:\\tmp\\shot.png" })).toEqual({
      ok: true,
      contentType: "image/png",
      kind: "image",
      size: 1000,
      filename: "shot.png",
    });
    expect(checkUploadRequest({ contentType: "application/pdf", size: 25 * 1024 * 1024, filename: "a.pdf" }).ok).toBe(
      true,
    );
    expect(checkUploadRequest({ contentType: "image/svg+xml", size: 10, filename: "a.svg" })).toEqual({
      ok: false,
      error: "media_type",
    });
    expect(checkUploadRequest({ contentType: "image/webp", size: 10 * 1024 * 1024 + 1, filename: "a" })).toEqual({
      ok: false,
      error: "media_too_large",
    });
    expect(checkUploadRequest({ contentType: "image/gif", size: 1.5, filename: "a" })).toEqual({
      ok: false,
      error: "media_empty",
    });
  });

  it("names files without paths, quotes or control characters", () => {
    expect(cleanFilename('../"evil"\u0000<b>.png', "png")).toBe("evilb.png");
    expect(cleanFilename("", "pdf")).toBe("file.pdf");
  });

  it("checks a file's first bytes against its type", () => {
    const bytes = (s: string) => new TextEncoder().encode(s);
    expect(sniffMatches("image/png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(sniffMatches("image/jpeg", Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(sniffMatches("image/gif", bytes("GIF89a..."))).toBe(true);
    expect(sniffMatches("image/webp", bytes("RIFF\0\0\0\0WEBPVP8 "))).toBe(true);
    expect(sniffMatches("application/pdf", bytes("%PDF-1.4"))).toBe(true);
    expect(sniffMatches("image/png", bytes("<svg onload=alert(1)>"))).toBe(false);
    expect(sniffMatches("application/pdf", bytes("<html><script>"))).toBe(false);
    expect(sniffMatches("image/webp", bytes("RIFF\0\0\0\0WAVE"))).toBe(false);
  });

  it("is off until the store's endpoint and keys are set", () => {
    expect(mediaConfigFromEnv({})).toBeNull();
    expect(mediaConfigFromEnv({ KNOWLEDGE_MEDIA_ENDPOINT: "http://os-minio:9000" })).toBeNull();
    expect(
      mediaConfigFromEnv({
        KNOWLEDGE_MEDIA_ENDPOINT: "http://os-minio:9000/",
        KNOWLEDGE_MEDIA_ACCESS_KEY: "k",
        KNOWLEDGE_MEDIA_SECRET_KEY: "s",
      }),
    ).toEqual({
      endpoint: "http://os-minio:9000",
      publicEndpoint: "http://os-minio:9000",
      bucket: "knowledge-media",
      region: "us-east-1",
      accessKeyId: "k",
      secretAccessKey: "s",
    });
  });
});

describe("images without an upload: an https address or SVG code", () => {
  const ok = (attrs: Record<string, unknown>) => parse({ type: "image", attrs: { alt: "A chart", ...attrs } });

  it("keeps an https image address, normalised and without its fragment", () => {
    const r = ok({ src: "  https://Example.com/a/chart.png?x=1#top " });
    expect(r.ok && r.doc.content[0]).toEqual({
      type: "image",
      attrs: { src: "https://example.com/a/chart.png?x=1", alt: "A chart", caption: "" },
    });
    expect(r.ok && mediaAssetIds(r.doc)).toEqual([]);
  });

  it("refuses addresses that aren't https on a named host", () => {
    for (const src of [
      "http://example.com/a.png",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "https://user:pw@example.com/a.png",
      "https://localhost/a.png",
      "https://10.0.0.1/a.png",
      "https://[::1]/a.png",
      "https://intranet/a.png",
      'https://example.com/a.png" onerror="x',
      `https://example.com/${"a".repeat(2000)}`,
    ]) {
      expect(checkImageUrl(src), src).toBeNull();
      expect(ok({ src }), src).toMatchObject({ ok: false, error: "image_url_invalid" });
    }
  });

  it("keeps SVG code, adding the namespace an <img> needs", () => {
    const r = ok({ svg: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>' });
    expect(r.ok && r.doc.content[0]!.attrs).toEqual({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
      alt: "A chart",
      caption: "",
    });
    const withDecl = '<?xml version="1.0"?>\n<!-- made by hand -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    expect(checkSvg(withDecl)).toEqual({ ok: true, svg: withDecl });
  });

  it("refuses SVG with script, handlers, foreign HTML or entities, and anything that isn't one <svg>", () => {
    const unsafe = [
      "<svg><script>alert(1)</script></svg>",
      '<svg onload="alert(1)"></svg>',
      '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>',
      "<svg><foreignObject><div>x</div></foreignObject></svg>",
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg></svg>',
      '<svg><iframe src="https://evil.example"></iframe></svg>',
    ];
    for (const svg of unsafe) expect(checkSvg(svg), svg).toMatchObject({ ok: false });
    expect(checkSvg('<svg onload="x"></svg>')).toEqual({ ok: false, error: "svg_unsafe" });
    for (const svg of ["<div>no</div>", "<svg>unclosed", "text <svg></svg>", 42]) {
      expect(checkSvg(svg), String(svg)).toEqual({ ok: false, error: "svg_invalid" });
    }
    expect(checkSvg(`<svg>${"x".repeat(100_001)}</svg>`)).toEqual({ ok: false, error: "svg_too_large" });
  });

  it("checks SVG in linear time, even with thousands of comments (no regular-expression backtracking)", () => {
    const evil = `<!--${"--><!--".repeat(14_000)}`; // what CodeQL flagged: no </svg>, many comment boundaries
    const t0 = performance.now();
    expect(checkSvg(evil)).toEqual({ ok: false, error: "svg_invalid" });
    expect(checkSvg(`${evil}--><svg></svg>`)).toMatchObject({ ok: true });
    expect(performance.now() - t0).toBeLessThan(200);
    // A doctype with an internal subset, two doctypes, or text before the root are not SVG code.
    expect(checkSvg("<!DOCTYPE svg [ ]><svg></svg>")).toEqual({ ok: false, error: "svg_invalid" });
    expect(checkSvg("<!DOCTYPE svg><!DOCTYPE svg><svg></svg>")).toEqual({ ok: false, error: "svg_invalid" });
    expect(checkSvg("<svgx></svgx>")).toEqual({ ok: false, error: "svg_invalid" });
    expect(checkSvg('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"><svg/></svg>')).toMatchObject({ ok: true });
  });

  it("an image has exactly one source, and still needs alt text", () => {
    expect(parse({ type: "image", attrs: { alt: "x" } })).toMatchObject({ ok: false, error: "media_invalid" });
    expect(ok({ asset: ID, src: "https://example.com/a.png" })).toMatchObject({ ok: false, error: "media_invalid" });
    expect(ok({ src: "https://example.com/a.png", svg: "<svg></svg>" })).toMatchObject({ ok: false });
    expect(parse({ type: "image", attrs: { src: "https://example.com/a.png", alt: " " } })).toMatchObject({
      ok: false,
      error: "image_alt_required",
    });
  });

  it("shows SVG only as a data: URL", () => {
    expect(svgDataUrl("<svg></svg>")).toBe("data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C%2Fsvg%3E");
  });
});
