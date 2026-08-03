import { describe, expect, test } from "vitest";
import {
  buildTrackNoticeEmail,
  noticeAddress,
  sendTrackNotice,
  NOTICE_FROM_ADDRESS,
} from "../src/track-notice-email";

function build(overrides: Partial<Parameters<typeof buildTrackNoticeEmail>[0]> = {}) {
  return buildTrackNoticeEmail({
    to: "jane@example.com",
    pilotName: "Jane Smith",
    compName: "Corryong Cup 2026",
    taskName: "Task 3",
    submitter: { kind: "anonymous", identifierLabel: "CIVL ID" },
    replaced: true,
    taskUrl: "https://glidecomp.com/comp/voqc/task/bqlf",
    organisers: [{ name: "Sam Organiser", email: "sam@example.com" }],
    ...overrides,
  });
}

describe("buildTrackNoticeEmail", () => {
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

describe("sendTrackNotice", () => {
  test("does nothing when the deployment cannot send", async () => {
    // Local dev and the worker tests have no EMAIL binding. That seam is what
    // lets everything else be tested without a mail mock.
    await expect(sendTrackNotice(undefined, build())).resolves.toBeUndefined();
  });

  test("never lets a mail failure escape", async () => {
    // The upload has already succeeded by the time this runs; a bounce must
    // not turn that into an error the pilot sees.
    const failing = {
      send: () => Promise.reject(new Error("E_SENDER_NOT_VERIFIED")),
    };
    await expect(sendTrackNotice(failing, build())).resolves.toBeUndefined();
  });

  test("hands the message to the binding when there is one", async () => {
    const sent: unknown[] = [];
    await sendTrackNotice(
      { send: (m) => (sent.push(m), Promise.resolve()) },
      build()
    );
    expect(sent).toHaveLength(1);
  });
});

describe("the three things it can be about", () => {
  test("an anonymous replacement — the original case", () => {
    const msg = build();
    expect(msg.subject).toBe("Your track for Task 3 was replaced");
    expect(msg.text).toContain("without signing in");
    expect(msg.text).toContain("restore your earlier track");
  });

  test("a FIRST anonymous submission, which used to send nothing at all", () => {
    // An anonymous first upload against somebody's registration is exactly as
    // unverified as an anonymous replacement. Sending only on replacements
    // meant the very first time a stranger filed as you, you heard nothing.
    const msg = build({ replaced: false });
    expect(msg.subject).toBe("A track was submitted for you at Corryong Cup 2026");
    expect(msg.text).toContain("has just been filed for you");
    // Nothing to restore — the wording must not offer it.
    expect(msg.text).not.toContain("restore your earlier track");
    expect(msg.text).toContain("The organiser can remove it");
  });

  test("a claimed registration, which is bigger than one track", () => {
    // Claiming links an account permanently, so future uploads go there too.
    // A subject line about a track would undersell it.
    const msg = build({
      replaced: false,
      claimedRegistration: true,
      submitter: { kind: "person", name: "Michael Lamb" },
    });
    expect(msg.subject).toBe("Your registration for Corryong Cup 2026 was claimed");
    expect(msg.text).toContain("Michael Lamb");
    expect(msg.text).toContain("their future uploads will go to it too");
  });

  test("a named submitter is named, because that is what makes it answerable", () => {
    const msg = build({ submitter: { kind: "person", name: "Michael Lamb" } });
    expect(msg.text).toContain("Michael Lamb");
    // And says nothing about identifiers, which only apply to anonymous.
    expect(msg.text).not.toContain("without signing in");
  });

  test("an anonymous submitter's identifier LABEL appears, never a value", () => {
    // The label tells the pilot which of their identifiers somebody is using
    // to submit as them — enough to act on. The VALUE would hand it to anyone
    // reading over their shoulder, so the builder is not even given one: the
    // only address in the message is the organiser's, deliberately.
    const msg = build({
      submitter: { kind: "anonymous", identifierLabel: "CIVL ID" },
      organisers: [],
    });
    expect(msg.text).toContain("CIVL ID");
    expect(msg.text, "no address of any kind when no organiser is named").not.toContain("@");
  });
});

describe("who the notice goes to", () => {
  test("prefers the account address once the registration is claimed", () => {
    // The registered address may be the very typo that made the pilot
    // unmatchable. Writing to it would tell a stranger that Jane flew task 3.
    expect(
      noticeAddress({
        pilot_id: 7,
        registered_pilot_email: "jane@gmial.com",
        account_email: "jane@gmail.com",
      })
    ).toBe("jane@gmail.com");
  });

  test("falls back to the registered address while nobody has claimed it", () => {
    expect(
      noticeAddress({
        pilot_id: null,
        registered_pilot_email: "jane@gmial.com",
        account_email: null,
      })
    ).toBe("jane@gmial.com");
  });

  test("a CLAIM goes to the registered address, never the claimer's account", () => {
    // The claim has just set pilot_id to the CLAIMER, so "prefer the account"
    // would mail the person who did it. A notice sent to its own subject is
    // not a notice — and this is the event where being told matters most,
    // because a wrong claim links an account permanently.
    expect(
      noticeAddress(
        {
          pilot_id: 7, // the claimer
          registered_pilot_email: "jane@gmial.com",
          account_email: "someone-else@example.com",
        },
        { forClaim: true }
      )
    ).toBe("jane@gmial.com");
  });

  test("a claim with no registered address has nobody to tell", () => {
    // Deliberately does NOT fall back to the account: that is the claimer.
    // The caller audits the silence instead.
    expect(
      noticeAddress(
        {
          pilot_id: 7,
          registered_pilot_email: null,
          account_email: "claimer@example.com",
        },
        { forClaim: true }
      )
    ).toBeNull();
  });

  test("is null when there is nobody to write to", () => {
    // Not an error: the upload still stands. The caller audits the silence.
    expect(
      noticeAddress({
        pilot_id: null,
        registered_pilot_email: null,
        account_email: null,
      })
    ).toBeNull();
  });
});
