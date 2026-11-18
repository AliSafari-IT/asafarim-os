import "server-only";
/**
 * An article body, rendered on the server: GitHub-flavoured Markdown, raw HTML never rendered, and the
 * result passed through rehype-sanitize's default schema (no scripts, event handlers or javascript:
 * links), the same pipeline shape as apps/docs. Phase 0 shows published Markdown only; the structured
 * editor and Mermaid diagrams come with their own issues.
 */
import { MarkdownAsync } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

export async function Markdown({ markdown }: { markdown: string }) {
  return (
    <div className="prose" data-testid="article-body">
      <MarkdownAsync remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} skipHtml>
        {markdown}
      </MarkdownAsync>
    </div>
  );
}
