import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EventsWarning } from "../components/EventsWarning";

const render = (types: string[]) => renderToStaticMarkup(createElement(EventsWarning, { appId: "tasks", types }));

describe("EventsWarning: an app's subscriptions waiting for their publisher (Apps page)", () => {
  it("renders nothing when every subscription has its publisher", () => {
    expect(render([])).toBe("");
  });

  it("shows the warning badge and each waiting type", () => {
    const html = render(["notes.note.created.v1", "notes.note.deleted.v1"]);
    expect(html).toContain('data-testid="events-warning-tasks"');
    expect(html).toContain('<span class="badge warn">Waiting for publisher</span>');
    expect(html).toContain("these events");
    expect(html).toContain('<li class="mono">notes.note.created.v1</li>');
    expect(html).toContain('<li class="mono">notes.note.deleted.v1</li>');
  });

  it("words one waiting type in the singular", () => {
    expect(render(["notes.note.created.v1"])).toContain("this event");
  });
});
