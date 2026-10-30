import { notFound } from "next/navigation";
import { Builder } from "@/components/builder/Builder";
import { HookSection } from "@/components/HookPanel";
import { Unavailable } from "@/components/Notice";
import { Shell } from "@/components/Shell";
import { buildCatalog } from "@/lib/builder/catalog";
import { builderProblems, checkDataOf } from "@/lib/builder/checks";
import { openWorkflow } from "@/lib/builder/open";
import { db, engine } from "@/lib/db";
import { generatedInfo, issuePageUrl } from "@/lib/generate/service";
import { listHooks } from "@/lib/hooks/store";
import { pageAccess } from "@/lib/page";
import { getBuilderWorkflow } from "@/lib/queries";
import type { InputField, TriggerV2 } from "@/lib/workflow/definition-v2";
import { KEY } from "@/lib/workflow/schema";
import "../../builder.css";

export const dynamic = "force-dynamic";

/**
 * The builder (components/builder/Builder.tsx) on a workflow: editable with flow.workflows.write,
 * read-only with flow.read. It opens the draft, or the published version when there is none. The
 * credentials it may pick from are names and ids only, and only for someone who may edit; so is the
 * workflow's hook (components/HookPanel.tsx, the Workflows page's), in a webhook or GitHub trigger's
 * settings.
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
  const hook = canWrite ? (await listHooks(pool)).find((h) => h.workflowKey === workflow.key) : undefined;
  const generated = workflow.versions.length ? null : await generatedInfo(pool, workflow.key);
  const t = opened.draft.trigger;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  // The panel for each trigger type the draft may be switched to; the hook's own kind is fixed.
  const triggerPanels = canWrite
    ? {
        webhook: (
          <HookSection
            workflow={workflow.key}
            hook={hook}
            checkNamed={false}
            back={`/workflows/${workflow.key}/edit`}
            trigger={{
              type: "webhook",
              hook: hook?.id ?? "",
              input: t.type === "webhook" && Array.isArray(t.input) ? (t.input as InputField[]) : [],
            }}
          />
        ),
        github: (
          <HookSection
            workflow={workflow.key}
            hook={hook}
            checkNamed={false}
            back={`/workflows/${workflow.key}/edit`}
            trigger={
              {
                type: "github",
                hook: hook?.id ?? "",
                repos: t.type === "github" && strings(t.repos).length ? strings(t.repos) : ["owner/name"],
                events: t.type === "github" && strings(t.events).length ? strings(t.events) : ["issues.opened"],
              } satisfies TriggerV2
            }
          />
        ),
      }
    : undefined;
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
        hookId={hook?.id ?? null}
        triggerPanels={triggerPanels}
        generated={
          generated
            ? {
                issue: {
                  label: `${generated.source.repo}#${generated.source.number}`,
                  url: issuePageUrl(generated.source),
                },
                summary: generated.summary,
                triggerNote: generated.triggerNote,
                notes: generated.notes,
              }
            : null
        }
      />
    </Shell>
  );
}
