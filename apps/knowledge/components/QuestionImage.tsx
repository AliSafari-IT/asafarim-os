/**
 * A question's picture: an https image on another site (sent no Referer), SVG code as a data: URL in an <img> (never
 * as markup, so nothing in it can run), or an uploaded image served by /media.
 */
import type { QuestionImage as Image } from "@/lib/assessment-core";
import { svgDataUrl } from "@/lib/media/validate";

export const questionImageSrc = (image: Image) =>
  image.assetId ? `/media/${image.assetId}` : image.url || (image.svg ? svgDataUrl(image.svg) : "");

export function QuestionImage({ image }: { image: Image }) {
  const src = questionImageSrc(image);
  if (!src) return null;
  return (
    <figure className="question-image">
      <img src={src} alt={image.alt} decoding="async" loading="lazy" referrerPolicy="no-referrer" />
    </figure>
  );
}
