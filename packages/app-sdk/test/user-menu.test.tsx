import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { hueOf, initialsOf, UserMenu } from "../src/react.tsx";

describe("UserMenu", () => {
  it("renders closed: an avatar with initials, named by the person, never an id", () => {
    const html = renderToStaticMarkup(<UserMenu name="ali.safari@example.test" email="ali.safari@example.test" />);
    expect(html).toContain('aria-label="Your account menu: ali.safari@example.test"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">AS<");
    expect(html).not.toContain("user-menu-account");
  });

  it("says 'Signed in' when it knows neither a name nor an email", () => {
    const html = renderToStaticMarkup(<UserMenu name={null} email={null} />);
    expect(html).toContain('aria-label="Your account menu: Signed in"');
    expect(html).toContain(">?<");
  });
});

describe("initialsOf and hueOf", () => {
  it("takes two letters from an email's local part or a name", () => {
    expect(initialsOf("ali.safari@example.test")).toBe("AS");
    expect(initialsOf("ali@example.test")).toBe("AL");
    expect(initialsOf("Ali Safari")).toBe("AS");
    expect(initialsOf("+31 6 1234")).toBe("#");
    expect(initialsOf(null)).toBe("?");
  });

  it("gives the same person the same hue, in range", () => {
    expect(hueOf("ali@example.test")).toBe(hueOf("ali@example.test"));
    expect(hueOf("ali@example.test")).toBeGreaterThanOrEqual(0);
    expect(hueOf("ali@example.test")).toBeLessThan(360);
    expect(hueOf(null)).toBe(0);
  });
});
