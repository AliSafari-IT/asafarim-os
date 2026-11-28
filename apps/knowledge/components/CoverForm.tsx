"use client";
/**
 * The studio's course cover form: an https image address, or pasted SVG code checked as you type with a live
 * preview. The preview (like the course pages) shows the SVG as a data: URL in an <img>, never as markup, so scripts
 * in it can't run; the server checks it again (checkCoverSvg, in lib/courses.ts) before storing it.
 */
import { useMemo, useState } from "react";
import { editCourseAction } from "@/app/studio/course-actions";
import { ERRORS } from "@/lib/messages";
import { checkCoverSvg, checkImageUrl, MEDIA_LIMITS, svgDataUrl } from "@/lib/media/validate";

type Source = "url" | "svg";

export function CoverForm(props: {
  courseId: string;
  revisionId: string;
  cover: { url: string; svg: string; alt: string };
  altLimit: number;
}) {
  const { cover } = props;
  const [source, setSource] = useState<Source>(cover.svg ? "svg" : "url");
  const [url, setUrl] = useState(cover.url);
  const [svg, setSvg] = useState(cover.svg);

  const svgCheck = useMemo(() => (svg.trim() ? checkCoverSvg(svg) : null), [svg]);
  const urlOk = url.trim() ? checkImageUrl(url) : "";

  let preview = "";
  let problem = "";
  if (source === "svg") {
    if (svgCheck?.ok) preview = svgDataUrl(svgCheck.svg);
    else if (svgCheck) problem = ERRORS[svgCheck.error]!;
  } else if (url.trim()) {
    if (urlOk) preview = urlOk;
    else problem = ERRORS.image_url_invalid!;
  }
  const empty = source === "svg" ? !svg.trim() : !url.trim();

  return (
    <form action={editCourseAction} className="card" id="cover" data-testid="course-cover-form">
      <h2>Cover image</h2>
      <p className="muted">
        Optional. Shown on the right of the course page header and on the courses list: an https address of an image on
        another site, or SVG code you paste here. Leave it empty to remove the cover.
      </p>
      <input type="hidden" name="id" value={props.courseId} />
      <input type="hidden" name="revision" value={props.revisionId} />
      <input type="hidden" name="op" value="cover" />
      <input type="hidden" name="source" value={source} />

      <div className="segmented" role="radiogroup" aria-label="Cover source">
        {(
          [
            ["url", "Image address"],
            ["svg", "SVG code"],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className={source === value ? "active" : undefined}>
            <input
              type="radio"
              name="cover-source"
              value={value}
              checked={source === value}
              onChange={() => setSource(value)}
              data-testid={`cover-source-${value}`}
            />
            {label}
          </label>
        ))}
      </div>

      {source === "url" ? (
        <label>
          Image address
          <input
            name="url"
            type="url"
            inputMode="url"
            placeholder="https://…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            maxLength={MEDIA_LIMITS.imageUrl}
            data-testid="cover-url"
          />
        </label>
      ) : (
        <label>
          SVG code
          <textarea
            name="svg"
            className="code-input"
            rows={8}
            value={svg}
            spellCheck={false}
            maxLength={MEDIA_LIMITS.svg}
            placeholder={'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">…</svg>'}
            onChange={(e) => setSvg(e.target.value)}
            aria-invalid={problem ? true : undefined}
            aria-describedby="cover-check"
            data-testid="cover-svg"
          />
        </label>
      )}

      <p
        id="cover-check"
        className={problem ? "cover-check bad" : "cover-check"}
        aria-live="polite"
        data-testid="cover-check"
      >
        {problem
          ? problem
          : empty
            ? "No cover: saving removes it."
            : source === "svg"
              ? `Valid SVG (${svgCheck?.ok ? svgCheck.svg.length.toLocaleString("en") : 0} characters). Scripts and links to other files are not allowed, and it is shown as a picture.`
              : "Readers' browsers load it from that site, so use one you trust to keep it online."}
      </p>

      {preview ? (
        <figure className="studio-cover-preview-frame">
          <img
            className="studio-cover-preview"
            src={preview}
            alt=""
            referrerPolicy="no-referrer"
            data-testid="cover-preview"
          />
          <figcaption className="muted">Preview</figcaption>
        </figure>
      ) : null}

      <label>
        Alt text <span className="muted">(what the image shows, for screen readers)</span>
        <input name="alt" defaultValue={cover.alt} maxLength={props.altLimit} />
      </label>
      <button type="submit" className="secondary" disabled={Boolean(problem)} data-testid="save-cover">
        Save cover
      </button>
    </form>
  );
}
