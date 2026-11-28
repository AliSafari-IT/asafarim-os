"use server";
/**
 * The assessment studio's mutations. Each passes the studio gate first; lib/assessments then checks, on the locked
 * course, that the person manages it (its owner, or someone who manages every course), and that the form shows the
 * assessment's current version.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { NO_IMAGE, type QuestionInput, type QuestionOption } from "@/lib/assessment-core";
import { changeBank, saveQuestion, updateSettings, type BankChange } from "@/lib/assessments";
import { generateAssessmentQuestions, parseGenerateOptions } from "@/lib/ai/assessment";
import { aiConfigFromEnv, createAnthropicProvider, type AiProvider } from "@/lib/ai/provider";
import { isUuid } from "@/lib/content";
import { db } from "@/lib/db";
import { studioGate } from "@/lib/studio";

const field = (f: FormData, name: string) => {
  const v = f.get(name);
  return typeof v === "string" ? v : "";
};
const int = (f: FormData, name: string) => {
  const n = Number(field(f, name));
  return Number.isSafeInteger(n) ? n : -1;
};

function back(courseId: string, q: Record<string, string>, anchor = ""): never {
  redirect(`/studio/courses/${courseId}/assessment?${new URLSearchParams(q)}${anchor ? `#${anchor}` : ""}`);
}

async function begin(formData: FormData) {
  const courseId = field(formData, "course");
  if (!isUuid(courseId)) redirect("/studio/courses?error=course_not_found");
  const g = await studioGate();
  if (!g.ok) redirect(g.status === 401 ? "/studio" : `/studio/courses/${courseId}/assessment?error=${g.error}`);
  return { courseId, actor: g.actor, version: int(formData, "version") };
}

/** Learners' pages read per request; this drops any cached copy. */
const refresh = () => revalidatePath("/courses", "layout");

export async function saveSettingsAction(formData: FormData) {
  const { courseId, actor, version } = await begin(formData);
  const r = await updateSettings(await db(), actor, {
    courseId,
    version,
    status: field(formData, "status") === "open" ? "open" : "draft",
    questionsPerAttempt: int(formData, "perAttempt"),
    passPercent: int(formData, "passPercent"),
  });
  refresh();
  back(courseId, r.ok ? { done: "assessment_settings_saved" } : { error: `assessment_${r.error}` }, "settings");
}

/** "New assessment" on the dashboard: go to the chosen course's assessment, at the AI generator. */
export async function startAssessmentAction(formData: FormData) {
  const courseId = field(formData, "course");
  if (!isUuid(courseId)) redirect("/studio/assessments?error=assessment_pick_course");
  redirect(`/studio/courses/${courseId}/assessment#generate`);
}

/** Open or close an assessment from the Assessments dashboard, keeping its other settings; back to the dashboard. */
export async function setAssessmentStatusAction(formData: FormData) {
  const courseId = field(formData, "course");
  if (!isUuid(courseId)) redirect("/studio/assessments?error=course_not_found");
  const g = await studioGate();
  if (!g.ok) redirect(g.status === 401 ? "/studio" : `/studio/assessments?error=${g.error}`);
  const status = field(formData, "status") === "open" ? "open" : "draft";
  const r = await updateSettings(await db(), g.actor, {
    courseId,
    version: int(formData, "version"),
    status,
    questionsPerAttempt: int(formData, "perAttempt"),
    passPercent: int(formData, "passPercent"),
  });
  refresh();
  revalidatePath("/studio/assessments");
  redirect(
    `/studio/assessments?${new URLSearchParams(
      r.ok
        ? { done: status === "open" ? "assessment_opened" : "assessment_closed" }
        : { error: `assessment_${r.error}`, course: courseId },
    )}`,
  );
}

function parseOptions(raw: string): QuestionOption[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v)
      ? v.slice(0, 12).map((o) => {
          const x = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
          return { id: String(x.id ?? ""), text: String(x.text ?? ""), correct: x.correct === true };
        })
      : [];
  } catch {
    return [];
  }
}

export async function saveQuestionAction(formData: FormData) {
  const { courseId, actor, version } = await begin(formData);
  const questionId = field(formData, "question");
  const source = field(formData, "imageSource");
  const question: QuestionInput = {
    kind: field(formData, "kind") === "multiple" ? "multiple" : "single",
    prompt: field(formData, "prompt"),
    options: parseOptions(field(formData, "options")),
    explanation: field(formData, "explanation"),
    lessonId: field(formData, "lesson") || null,
    difficulty: (["easy", "medium", "hard"].includes(field(formData, "difficulty"))
      ? field(formData, "difficulty")
      : "medium") as QuestionInput["difficulty"],
    image: {
      ...NO_IMAGE,
      url: source === "url" ? field(formData, "imageUrl") : "",
      svg: source === "svg" ? field(formData, "imageSvg") : "",
      assetId: source === "upload" ? field(formData, "imageAsset") || null : null,
      alt: source === "none" ? "" : field(formData, "imageAlt"),
    },
  };
  const r = await saveQuestion(await db(), actor, {
    courseId,
    version,
    questionId: isUuid(questionId) ? questionId : null,
    question,
    status: field(formData, "status") === "active" ? "active" : "draft",
  });
  refresh();
  if (!r.ok)
    back(courseId, { error: `assessment_${r.error}`, ...(questionId ? { edit: questionId } : { new: "1" }) }, "editor");
  back(courseId, { done: "assessment_question_saved" }, `q-${r.id}`);
}

export async function bankAction(formData: FormData) {
  const { courseId, actor, version } = await begin(formData);
  const questionId = field(formData, "question");
  let change: BankChange;
  switch (field(formData, "op")) {
    case "delete":
      change = { op: "delete", questionId };
      break;
    case "approve":
      change = { op: "status", questionId, status: "active" };
      break;
    case "unapprove":
      change = { op: "status", questionId, status: "draft" };
      break;
    case "up":
    case "down":
      change = { op: "move", questionId, delta: field(formData, "op") === "up" ? -1 : 1 };
      break;
    case "approve_drafts":
      change = { op: "approve_drafts" };
      break;
    case "delete_drafts":
      change = { op: "delete_drafts" };
      break;
    default:
      back(courseId, { error: "assessment_unknown_question" });
  }
  const r = await changeBank(await db(), actor, { courseId, version, change });
  refresh();
  const anchor = change.op === "move" || change.op === "status" ? `q-${questionId}` : "questions";
  back(
    courseId,
    r.ok
      ? { done: change.op === "delete" ? "assessment_question_deleted" : "assessment_bank_changed" }
      : { error: `assessment_${r.error}` },
    anchor,
  );
}

const globalForAi = globalThis as unknown as { knowledgeAssessmentAi?: { key: string; provider: AiProvider } };

export async function generateQuestionsAction(formData: FormData) {
  const { courseId, actor } = await begin(formData);
  const config = aiConfigFromEnv();
  if (!config) back(courseId, { error: "ai_off" }, "generate");
  const parsed = parseGenerateOptions({
    count: int(formData, "count"),
    kinds: field(formData, "kinds"),
    difficulty: field(formData, "difficulty"),
    lessonIds: formData.getAll("lessons").filter((x): x is string => typeof x === "string"),
    diagrams: field(formData, "diagrams") === "on",
    instruction: field(formData, "instruction"),
  });
  if (!parsed.ok) back(courseId, { error: parsed.error }, "generate");
  // The assessment model can differ from the writing assistant's (a faster one for long batches).
  const model = process.env.KNOWLEDGE_AI_ASSESSMENT_MODEL?.trim() || config.model;
  const key = `${model}|${config.effort}`;
  if (globalForAi.knowledgeAssessmentAi?.key !== key) {
    globalForAi.knowledgeAssessmentAi = { key, provider: createAnthropicProvider({ ...config, model }) };
  }
  const r = await generateAssessmentQuestions(
    await db(),
    { provider: globalForAi.knowledgeAssessmentAi.provider, caps: config },
    actor,
    { courseId, options: parsed.options },
  );
  if (!r.ok) back(courseId, { error: r.error === "forbidden" ? "assessment_ai_forbidden" : r.error }, "generate");
  back(courseId, { generated: String(r.added), ...(r.trimmed ? { trimmed: "1" } : {}) }, "questions");
}
