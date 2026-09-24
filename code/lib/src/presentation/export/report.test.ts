/**
 * The report builder.
 *
 * Pure string work, so it is tested directly. The thing most worth pinning is
 * escaping: a report embeds names that came from somebody's file, and a leaf
 * called `<script>` must not become one.
 */

import { describe, expect, it } from "vitest";
import { renderReport, type Report } from "./report";

const minimal = (over: Partial<Report> = {}): Report => ({
  title: "Vibrio NJ vs UPGMA",
  generated: new Date("2026-09-24T10:30:00Z"),
  sections: [],
  ...over,
});

describe("renderReport", () => {
  it("is a self-contained document", () => {
    const html = renderReport(minimal());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    // Styles inline, so the file travels on its own.
    expect(html).toContain("<style>");
    expect(html).not.toContain("<link");
    expect(html).toContain("Vibrio NJ vs UPGMA");
  });

  it("stamps when it was made", () => {
    expect(renderReport(minimal())).toContain("2026-09-24 10:30");
  });

  it("escapes everything that came from a file", () => {
    // Leaf labels, species and comparison names are user data.
    const html = renderReport(
      minimal({
        title: '<script>alert("x")</script>',
        sections: [
          {
            heading: "A & B",
            fields: [{ label: "<b>leaf</b>", value: '"quoted"' }],
            caution: "<img onerror=1>",
          },
        ],
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img onerror");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("A &amp; B");
    expect(html).toContain("&quot;quoted&quot;");
  });

  it("embeds images rather than linking them", () => {
    const html = renderReport(
      minimal({
        sections: [
          { heading: "Trees", images: [{ src: "data:image/png;base64,AAA", caption: "Left" }] },
        ],
      }),
    );
    expect(html).toContain('src="data:image/png;base64,AAA"');
    expect(html).toContain("<figcaption>Left</figcaption>");
  });

  it("sets a caution apart rather than burying it in the prose", () => {
    const html = renderReport(
      minimal({ sections: [{ heading: "Matching", caution: "Different species." }] }),
    );
    expect(html).toMatch(/class="caution">Different species\./);
  });

  it("carries a field's note, which is where a number's caveat lives", () => {
    const html = renderReport(
      minimal({
        sections: [
          {
            heading: "Distance",
            fields: [{ label: "RF", value: "6,825", note: "0.193 normalised" }],
          },
        ],
      }),
    );
    expect(html).toContain("0.193 normalised");
  });

  it("omits sections it was given nothing for", () => {
    const html = renderReport(minimal({ sections: [{ heading: "Empty" }] }));
    expect(html).toContain("Empty");
    expect(html).not.toContain("<dl");
    expect(html).not.toContain("<figure>");
  });
});

describe("legends", () => {
  it("names each colour, so the pictures can be read at all", () => {
    // Without this a reader sees that two clades differ in colour and has no
    // way to learn what either colour means.
    const html = renderReport({
      title: "t",
      generated: new Date("2026-09-24T10:30:00Z"),
      sections: [
        {
          heading: "View setup",
          swatches: [
            { label: "Human", color: "#e05c5c" },
            { label: "Environment", color: "#2f5fd0" },
          ],
        },
      ],
    });
    expect(html).toContain("background:#e05c5c");
    expect(html).toContain("Human");
    expect(html).toContain("Environment");
  });

  it("escapes a colour, which is a string like any other", () => {
    const html = renderReport({
      title: "t",
      generated: new Date("2026-09-24T10:30:00Z"),
      sections: [{ heading: "h", swatches: [{ label: "x", color: '"><script>' }] }],
    });
    expect(html).not.toContain("<script>");
  });
});
