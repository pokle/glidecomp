import { describe, expect, test } from "vitest";
import {
  buildTrackReplacedEmail,
  sendTrackReplacedNotice,
  NOTICE_FROM_ADDRESS,
} from "../src/track-replaced-email";

function build(overrides: Partial<Parameters<typeof buildTrackReplacedEmail>[0]> = {}) {
  return buildTrackReplacedEmail({
    to: "jane@example.com",
    pilotName: "Jane Smith",
    compName: "Corryong Cup 2026",
    taskName: "Task 3",
    identifierLabel: "CIVL ID",
    taskUrl: "https://glidecomp.com/comp/voqc/task/bqlf",
    organisers: [{ name: "Sam Organiser", email: "sam@example.com" }],
    ...overrides,
  });
}

describe("buildTrackReplacedEmail", () => {
  test("says what happened, to whom, and where to look", () => {
    const msg = build();
    expect(msg.to).toBe("jane@example.com");
    expect(msg.from).toBe(NOTICE_FROM_ADDRESS);
    expect(msg.subject).toBe("Your track for Task 3 was replaced");
    for (const part of [msg.text, msg.html]) {
      expect(part).toContain("Jane Smith");
      expect(part).toContain("Corryong Cup 2026");
      expect(part).toContain("Task 3");
      expect(part).toContain("https://glidecomp.com/comp/voqc/task/bqlf");
    }
  });

  test("names how the submitter identified the pilot, never the value", () => {
    const msg = build();
    // The label tells the pilot which of their identifiers is being used to
    // submit as them, which is what they need to act on. The value would just
    // hand it to anyone reading over their shoulder.
    expect(msg.text).toContain("CIVL ID");
  });

  test("gives the pilot somebody to contact who can undo it", () => {
    const msg = build();
    expect(msg.text).toContain("Sam Organiser (sam@example.com)");
    expect(msg.html).toContain('<a href="mailto:sam@example.com">');
  });

  test("still reads correctly when the comp has no named organiser", () => {
    const msg = build({ organisers: [] });
    expect(msg.text).toContain("contact the competition organiser");
    expect(msg.html).toContain("contact the competition organiser");
  });

  test("lists several organisers readably", () => {
    const msg = build({
      organisers: [
        { name: "Sam", email: "sam@example.com" },
        { name: "Alex", email: "alex@example.com" },
      ],
    });
    expect(msg.text).toContain("Sam (sam@example.com) or Alex (alex@example.com)");
  });

  test("escapes names into the HTML part", () => {
    const msg = build({ pilotName: 'Jane "The Hammer" <script>' });
    expect(msg.html).not.toContain("<script>");
    expect(msg.html).toContain("&lt;script&gt;");
    // The text part is not markup and must stay verbatim.
    expect(msg.text).toContain('Jane "The Hammer" <script>');
  });

  test("carries both parts and no images or tracking", () => {
    const msg = build();
    expect(msg.text.length).toBeGreaterThan(0);
    expect(msg.html.length).toBeGreaterThan(0);
    expect(msg.html).not.toContain("<img");
  });

  test("uses Australian spelling", () => {
    const msg = build();
    expect(msg.text).toContain("organiser");
    expect(msg.text).not.toContain("organizer");
  });
});

describe("sendTrackReplacedNotice", () => {
  test("does nothing when the deployment cannot send", async () => {
    // Local dev and the worker tests have no EMAIL binding. That seam is what
    // lets everything else be tested without a mail mock.
    await expect(sendTrackReplacedNotice(undefined, build())).resolves.toBeUndefined();
  });

  test("never lets a mail failure escape", async () => {
    // The upload has already succeeded by the time this runs; a bounce must
    // not turn that into an error the pilot sees.
    const failing = {
      send: () => Promise.reject(new Error("E_SENDER_NOT_VERIFIED")),
    };
    await expect(sendTrackReplacedNotice(failing, build())).resolves.toBeUndefined();
  });

  test("hands the message to the binding when there is one", async () => {
    const sent: unknown[] = [];
    await sendTrackReplacedNotice(
      { send: (m) => (sent.push(m), Promise.resolve()) },
      build()
    );
    expect(sent).toHaveLength(1);
  });
});
