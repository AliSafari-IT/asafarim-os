/**
 * A learner's assessment insights: the score trend over attempts, mastery per module and per lesson (recent attempts
 * weigh more), what to study next, and how they do by difficulty and question type. Server-rendered SVG and lists;
 * every value is written out as text too, so nothing depends on colour alone.
 */
import Link from "next/link";
import type { AreaInsight, AssessmentInsights as Insights, MasteryLevel } from "@/lib/assessment-core";

const LEVEL_LABEL: Record<MasteryLevel, string> = {
  strong: "Strong",
  developing: "Developing",
  needs_work: "Needs work",
};

const fmtDate = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** The score of each attempt, oldest to newest, with the pass mark as a dashed rule. */
export function ScoreTrend({ history, passPercent }: { history: Insights["history"]; passPercent: number }) {
  if (history.length < 2) return null;
  const W = 600;
  const H = 160;
  const pad = { l: 34, r: 12, t: 12, b: 22 };
  const x = (i: number) => pad.l + (i * (W - pad.l - pad.r)) / (history.length - 1);
  const y = (v: number) => pad.t + ((100 - v) * (H - pad.t - pad.b)) / 100;
  const points = history.map((h, i) => `${x(i)},${y(h.score)}`).join(" ");
  return (
    <figure className="chart-figure score-trend" data-testid="score-trend">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Scores over ${history.length} attempts`}
        className="trend-svg"
      >
        {[0, 50, 100].map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="trend-grid" />
            <text x={pad.l - 6} y={y(v) + 4} className="trend-axis" textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        <line x1={pad.l} x2={W - pad.r} y1={y(passPercent)} y2={y(passPercent)} className="trend-pass" />
        <text x={W - pad.r} y={y(passPercent) - 4} className="trend-axis" textAnchor="end">
          pass {passPercent}%
        </text>
        <polyline points={points} className="trend-line" />
        {history.map((h, i) => (
          <g key={h.id} className="trend-point">
            {/* A hit target bigger than the dot, with the value on hover. */}
            <circle cx={x(i)} cy={y(h.score)} r={12} className="trend-hit">
              <title>{`Attempt ${i + 1}, ${fmtDate(h.submittedAt)}: ${h.score}%`}</title>
            </circle>
            <circle cx={x(i)} cy={y(h.score)} r={4.5} className="trend-dot" />
            {i === history.length - 1 ? (
              <text x={x(i)} y={y(h.score) - 10} className="trend-label" textAnchor="end">
                {h.score}%
              </text>
            ) : null}
          </g>
        ))}
      </svg>
      <figcaption className="muted">
        Your score in each attempt, oldest to newest: {history.map((h) => `${h.score}%`).join(", ")}.
      </figcaption>
    </figure>
  );
}

export function MasteryList({ areas, slug, testid }: { areas: AreaInsight[]; slug?: string; testid: string }) {
  return (
    <ul className="mastery-list" data-testid={testid}>
      {areas.map((a) => {
        const trend =
          a.latest !== null && a.previous !== null
            ? a.latest > a.previous
              ? { sign: "▲", text: `up from ${a.previous}%` }
              : a.latest < a.previous
                ? { sign: "▼", text: `down from ${a.previous}%` }
                : null
            : null;
        return (
          <li key={a.key} className={`mastery-row ${a.level}`}>
            <div className="mastery-name">
              {slug && a.lessonId ? (
                <Link href={`/courses/${slug}/lessons/${a.lessonId}`}>{a.title}</Link>
              ) : (
                <span>{a.title}</span>
              )}
              {a.lessonId && a.moduleTitle && slug ? <span className="muted"> · {a.moduleTitle}</span> : null}
            </div>
            <div className="mastery-bar" aria-hidden="true">
              <div className="mastery-fill" style={{ width: `${Math.max(2, a.mastery)}%` }} />
            </div>
            <div className="mastery-value">
              <strong>{a.mastery}%</strong> <span className={`level-tag ${a.level}`}>{LEVEL_LABEL[a.level]}</span>
              {trend ? (
                <span className="muted mastery-trend" title={trend.text}>
                  {" "}
                  <span aria-hidden="true">{trend.sign}</span>
                  <span className="sr-only">{trend.text}</span>
                </span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function AssessmentInsightsView({
  insights,
  slug,
  passPercent,
}: {
  insights: Insights;
  slug: string;
  passPercent: number;
}) {
  if (!insights.attempts) return null;
  const modules = [...insights.modules].sort((a, b) => a.mastery - b.mastery);
  const lessons = [...insights.lessons].sort((a, b) => a.mastery - b.mastery);
  return (
    <section className="assessment-insights" aria-labelledby="insights-heading" data-testid="assessment-insights">
      <p className="eyebrow">Your insights</p>
      <h2 id="insights-heading">Where to study more</h2>
      <p className="muted">
        Mastery counts every question you answered on a topic, your recent attempts weighing more than older ones.
      </p>

      <div className="card focus-card" data-testid="focus-areas">
        <h3>Study next</h3>
        {insights.focus.length ? (
          <ol className="focus-list">
            {insights.focus.map((a) => (
              <li key={a.key}>
                {a.lessonId ? (
                  <Link href={`/courses/${slug}/lessons/${a.lessonId}`}>{a.title}</Link>
                ) : (
                  <span>{a.title}</span>
                )}{" "}
                <span className="muted">
                  {a.moduleTitle} · {a.mastery}% over {a.asked} {a.asked === 1 ? "question" : "questions"}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p>
            Nothing below 70%: every topic you were asked about is in good shape. Keep it fresh with the study cards.
          </p>
        )}
      </div>

      <div className="card">
        <h3>Score trend</h3>
        {insights.history.length >= 2 ? (
          <ScoreTrend history={insights.history} passPercent={passPercent} />
        ) : (
          <p className="muted">Your trend appears after your second attempt.</p>
        )}
      </div>

      <div className="insights-two">
        <div className="card">
          <h3>By module</h3>
          <MasteryList areas={modules} testid="module-mastery" />
        </div>
        <div className="card">
          <h3>By lesson</h3>
          <MasteryList areas={lessons} slug={slug} testid="lesson-mastery" />
        </div>
      </div>

      <div className="insights-two">
        <div className="card">
          <h3>By difficulty</h3>
          <ul className="split-list">
            {insights.byDifficulty.map((d) => (
              <li key={d.difficulty}>
                <span className="split-name">{d.difficulty[0]!.toUpperCase() + d.difficulty.slice(1)}</span>
                <span className="split-value">
                  {d.percent}% <span className="muted">of {d.asked}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="card">
          <h3>By question type</h3>
          <ul className="split-list">
            {insights.byKind.map((k) => (
              <li key={k.kind}>
                <span className="split-name">{k.kind === "single" ? "Single answer" : "Multiple correct"}</span>
                <span className="split-value">
                  {k.percent}% <span className="muted">of {k.asked}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
