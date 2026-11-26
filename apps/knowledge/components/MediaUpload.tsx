"use client";
/** The media page's upload (#359): the same direct upload the editor uses, then the page refreshes its list. */
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { uploadFile } from "@/lib/media-nodes";
import { MEDIA_TYPES } from "@/lib/media/validate";
import { ERRORS } from "@/lib/messages";

export function MediaUpload() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<{ busy: boolean; bad?: boolean; text?: string }>({ busy: false });
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setState({ busy: true, text: `Uploading ${file.name}…` });
    const r = await uploadFile(file).catch(() => ({ ok: false as const, error: "media_not_uploaded" }));
    setState(
      r.ok
        ? { busy: false, text: `${r.asset.filename} uploaded.` }
        : { busy: false, bad: true, text: ERRORS[r.error] ?? r.error },
    );
    if (input.current) input.current.value = "";
    if (r.ok) router.refresh();
  };
  return (
    <div className="card" data-testid="media-upload">
      <h2>Upload</h2>
      <p className="muted">
        PNG, JPEG, GIF or WebP images up to 10 MB, PDFs up to 25 MB. Files no article uses are removed after a week.
      </p>
      <label>
        File
        <input
          ref={input}
          type="file"
          accept={Object.keys(MEDIA_TYPES).join(",")}
          disabled={state.busy}
          onChange={(e) => onFile(e.target.files?.[0])}
        />
      </label>
      {state.text ? (
        <p className={state.bad ? "notice bad" : "muted"} role={state.bad ? "alert" : "status"}>
          {state.text}
        </p>
      ) : null}
    </div>
  );
}
