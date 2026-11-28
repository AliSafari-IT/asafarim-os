/**
 * The Studio's section tabs, the same on every Studio section page. Each tab shows only to someone who may use it
 * (the pages check again).
 */
import Link from "next/link";
import { canCreateCourse, canManageTaxonomy, seesAllCourses, type Actor } from "@/lib/policy";

export type StudioSection = "articles" | "media" | "courses" | "assessments" | "taxonomy" | "insights";

export function StudioTabs({ actor, current }: { actor: Actor; current: StudioSection }) {
  const courses = canCreateCourse(actor) || seesAllCourses(actor);
  const tabs: { key: StudioSection; href: string; label: string; testid: string; show: boolean }[] = [
    { key: "articles", href: "/studio", label: "Articles", testid: "articles-link", show: true },
    { key: "media", href: "/studio/media", label: "Media", testid: "media-link", show: true },
    { key: "courses", href: "/studio/courses", label: "Courses", testid: "courses-link", show: courses },
    {
      key: "assessments",
      href: "/studio/assessments",
      label: "Assessments",
      testid: "assessments-link",
      show: canCreateCourse(actor),
    },
    {
      key: "taxonomy",
      href: "/studio/taxonomy",
      label: "Topics and tags",
      testid: "taxonomy-link",
      show: canManageTaxonomy(actor),
    },
    { key: "insights", href: "/studio/insights", label: "Insights", testid: "insights-link", show: true },
  ];
  return (
    <nav className="studio-tabs" aria-label="Studio sections">
      {tabs
        .filter((t) => t.show)
        .map((t) => (
          <Link key={t.key} href={t.href} data-testid={t.testid} aria-current={t.key === current ? "page" : undefined}>
            {t.label}
          </Link>
        ))}
    </nav>
  );
}
