import Link from "next/link";
import { TopBar } from "@/components/TopBar";

export default function NotFound() {
  return (
    <>
      <TopBar />
      <main data-testid="not-found">
        <h1>Not found</h1>
        <p className="muted">There&apos;s no published article here.</p>
        <Link href="/">All articles</Link>
      </main>
    </>
  );
}
