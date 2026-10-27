/**
 * A draft's body rendered as it will read on GitHub, near enough: GitHub-flavoured Markdown, raw HTML
 * never rendered, everything through rehype-sanitize's default schema first (the draft is untrusted),
 * then links made safe (lib/rehype.ts). Runs on the server for the first paint and in the browser as
 * the approver edits.
 */
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { rehypeDraftLinks } from "@/lib/rehype";

export function Preview({ markdown }: { markdown: string }) {
  return (
    <div className="markdown" data-testid="preview">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize, rehypeDraftLinks]}>
        {markdown}
      </Markdown>
    </div>
  );
}
