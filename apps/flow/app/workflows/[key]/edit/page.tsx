import { notFound } from "next/navigation";
import { Builder } from "@/components/builder/Builder";
import { Unavailable } from "@/components/Notice";
import { Shell } from "@/components/Shell";
import { buildCatalog } from "@/lib/builder/catalog";
import { builderProblems, checkDataOf } from "@/lib/builder/checks";
import { openWorkflow } from "@/lib/builder/open";
import { db, engine } from "@/lib/db";
import { pageAccess } from "@/lib/page";
import { getBuilderWorkflow } from "@/lib/queries";
import { KEY } from "@/lib/workflow/schema";
import "../../builder.css";

export const dynamic = "force-dynamic";

/**
 * The builder (components/builder/Builder.tsx) on a workflow: editable with flow.workflows.write,
 * read-only with flow.read. It opens the draft, or the published version when there is none. The
 * credentials it may pick from are names and ids only, and only for someone who may edit.
 */
export default async function EditWorkflow({ params }: { params: Promise<{ key: string }> }) {
  const access = await pageAccess();
  if (!access.ok) {
    return (
      <Shell current="/workflows">
        <Unavailable message={access.message} />
      </Shell>
    );
  }
  const { key } = await params;
  if (!KEY.test(key) || key.length > 64) notFound();
  const pool = await db();
  const workflow = await getBuilderWorkflow(pool, key);
  if (!workflow) notFound();
  const canWrite = access.permissions.includes("flow.workflows.write");
  const opened = openWorkflow(workflow);
  const data = await checkDataOf(pool);
  const problems = builderProblems(opened.draft, engine.checkDefinition(opened.draft), data);
  return (
    <Shell current="/workflows" wide>
      <Builder
        workflowKey={workflow.key}
        name={workflow.name}
        initial={opened.draft}
        from={opened.from}
        lastSeen={workflow.draftUpdatedAt?.toISOString() ?? null}
        catalog={buildCatalog()}
        credentials={canWrite ? data.credentials : []}
        problems={problems}
        canWrite={canWrite}
        published={workflow.versions[0]?.version ?? null}
      />
    </Shell>
  );
}
