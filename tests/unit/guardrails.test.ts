import { describe, expect, it } from 'vitest';
import { auditOutput, guardrailMessages, guardrailsFor } from '~/orchestrator/guardrails';
import { buildMessages } from '~/orchestrator/runTask';
import { normaliseTagList } from '~/lib/clipboard';
import { defaultState } from '~/storage/schema';
import type { VideoContext } from '~/types/VideoContext';

function video(overrides: Partial<VideoContext> = {}): VideoContext {
  return {
    videoId: 'tqygzPrAkjY',
    title: 'Build an AI Agent',
    description: 'A tutorial.',
    tags: [],
    suggestedHashtags: [],
    descriptionHashtags: [],
    durationSec: 742,
    publishedAtMs: Date.parse('2025-08-19T00:00:00Z'),
    channelId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
    category: 'Education',
    categoryRaw: 'CREATOR_VIDEO_CATEGORY_EDUCATION',
    license: 'STANDARD_YOUTUBE_LICENSE',
    privacy: 'public',
    status: 'processed',
    metadataLanguage: 'en',
    madeForKids: false,
    ageRestricted: false,
    allowEmbed: true,
    allowRatings: true,
    paidPromotion: false,
    alteredContent: 'no',
    originalFilename: null,
    shareUrl: 'https://youtu.be/tqygzPrAkjY',
    thumbnails: [],
    abTest: { state: 'none', result: null, arms: [] },
    monetization: { effectiveStatus: 'UNKNOWN', selfCertDecision: 'UNKNOWN' },
    copyright: { activeClaimCount: 0, hasImpact: false },
    ...overrides,
  };
}

/**
 * Guardrails are tested by asserting the MESSAGES change, never by asserting
 * model output. The former is deterministic; the latter is not, and a test that
 * depends on what a model chooses to say is a test that fails at random.
 */
describe('guardrailsFor', () => {
  it('applies nothing to a clean video', () => {
    expect(guardrailsFor('optimize_title', video())).toEqual([]);
  });

  it('applies nothing when there is no video', () => {
    expect(guardrailsFor('optimize_title', null)).toEqual([]);
  });

  it('constrains tone for a made-for-kids video', () => {
    const rails = guardrailsFor('optimize_title', video({ madeForKids: true }));
    expect(rails.map((rail) => rail.id)).toEqual(['made-for-kids']);
    expect(rails[0]!.instruction).toContain('no clickbait');
    expect(rails[0]!.mandatory).toBe(false);
  });

  it('requires a disclosure on description tasks for paid promotion', () => {
    const rails = guardrailsFor('optimize_description', video({ paidPromotion: true }));
    const disclosure = rails.find((rail) => rail.id === 'paid-promotion');

    expect(disclosure).toBeDefined();
    // The one constraint with legal rather than editorial weight.
    expect(disclosure!.mandatory).toBe(true);
    expect(disclosure!.instruction).toContain('MUST');
  });

  it('does not attach a disclosure rule to a task that writes no description', () => {
    // Telling a chapter generator about disclosures is noise that dilutes the
    // instructions that actually matter for it.
    const rails = guardrailsFor('chapter_generator', video({ paidPromotion: true }));
    expect(rails.map((rail) => rail.id)).not.toContain('paid-promotion');
  });

  it('applies altered-content guidance only to tag generation', () => {
    expect(
      guardrailsFor('generate_tags', video({ alteredContent: 'yes' })).map((rail) => rail.id),
    ).toContain('altered-content');
    expect(
      guardrailsFor('optimize_title', video({ alteredContent: 'yes' })).map((rail) => rail.id),
    ).not.toContain('altered-content');
  });

  it('tells the model an age-restricted audience is adult', () => {
    const rails = guardrailsFor('suggest_thumbnail_text', video({ ageRestricted: true }));
    expect(rails.map((rail) => rail.id)).toContain('age-restricted');
    expect(rails.find((rail) => rail.id === 'age-restricted')!.instruction).toContain('18+');
  });

  it('warns about copyright claims on every task, and says whether money is affected', () => {
    const affected = guardrailsFor(
      'generate_tags',
      video({ copyright: { activeClaimCount: 2, hasImpact: true } }),
    );
    const rail = affected.find((entry) => entry.id === 'copyright-claim');
    expect(rail?.label).toBe('2 copyright claims');
    expect(rail?.instruction).toContain('affecting monetization');

    const unaffected = guardrailsFor(
      'generate_tags',
      video({ copyright: { activeClaimCount: 1, hasImpact: false } }),
    );
    expect(unaffected.find((entry) => entry.id === 'copyright-claim')?.label).toBe(
      '1 copyright claim',
    );
  });

  it('stacks several constraints on one video', () => {
    const rails = guardrailsFor(
      'optimize_description',
      video({
        madeForKids: true,
        paidPromotion: true,
        copyright: { activeClaimCount: 1, hasImpact: true },
      }),
    );
    expect(rails.map((rail) => rail.id).sort()).toEqual([
      'copyright-claim',
      'made-for-kids',
      'paid-promotion',
    ]);
  });
});

describe('guardrailMessages', () => {
  it('emits nothing when there are no constraints', () => {
    expect(guardrailMessages([])).toEqual([]);
  });

  it('puts mandatory constraints before advisory ones', () => {
    const rails = guardrailsFor(
      'optimize_description',
      video({ madeForKids: true, paidPromotion: true }),
    );
    const content = guardrailMessages(rails)[0]!.content;

    // Match the per-rail markers, not the heading — the heading itself starts
    // with the word CONSTRAINTS.
    expect(content.indexOf('REQUIRED —')).toBeGreaterThan(-1);
    expect(content.indexOf('REQUIRED —')).toBeLessThan(content.indexOf('CONSTRAINT —'));
  });

  it('states that constraints outrank later instructions', () => {
    const content = guardrailMessages(
      guardrailsFor('optimize_title', video({ madeForKids: true })),
    )[0]!.content;
    expect(content).toContain('take');
    expect(content).toContain('precedence');
  });
});

describe('buildMessages with guardrails', () => {
  it('places guardrails ahead of the user-editable task prompt', () => {
    // The task prompt can be rewritten by the user; guardrails must not be
    // deletable by editing it, and must not be readable as overridden by it.
    const messages = buildMessages(
      'optimize_description',
      defaultState(),
      video({ paidPromotion: true }),
    );

    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('CONSTRAINTS FROM THIS VIDEO');
    expect(messages[1]!.role).toBe('system');
    expect(messages[1]!.content).toContain('You write YouTube descriptions');
  });

  it('sends only the task prompt when nothing applies', () => {
    const messages = buildMessages('optimize_description', defaultState(), video());
    expect(messages[0]!.content).toContain('You write YouTube descriptions');
  });

  it('changes the request for a flagged video versus a clean one', () => {
    // The observable, deterministic effect of the guardrail engine.
    const clean = buildMessages('optimize_description', defaultState(), video());
    const flagged = buildMessages(
      'optimize_description',
      defaultState(),
      video({ paidPromotion: true }),
    );

    expect(flagged.length).toBe(clean.length + 1);
    expect(JSON.stringify(flagged)).toContain('paid-promotion'.replace('-', ' ').toUpperCase());
  });
});

describe('auditOutput', () => {
  const rails = guardrailsFor('optimize_description', video({ paidPromotion: true }));

  it('flags a description that omits a required disclosure', () => {
    const findings = auditOutput(rails, 'Great tutorial about building agents. Subscribe!');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.guardrail).toBe('paid-promotion');
    expect(findings[0]!.message).toContain('does not appear to include a disclosure');
  });

  it('accepts any of the common disclosure phrasings', () => {
    for (const text of [
      'This video includes paid promotion.',
      'Paid partnership with Acme.',
      'This video is sponsored by Acme.',
      'In partnership with Acme Corp.',
      '#ad — thanks to Acme.',
    ]) {
      expect(auditOutput(rails, text), text).toEqual([]);
    }
  });

  it('says nothing when no mandatory constraint applied', () => {
    const advisoryOnly = guardrailsFor('optimize_title', video({ madeForKids: true }));
    expect(auditOutput(advisoryOnly, 'A perfectly ordinary title')).toEqual([]);
  });

  it('does not flag empty output, which is a cancelled run rather than a violation', () => {
    expect(auditOutput(rails, '')).toEqual([]);
    expect(auditOutput(rails, '   ')).toEqual([]);
  });
});

/* ========================================================================== */
/* Tag list normalisation — what "Copy All" actually pastes                     */
/* ========================================================================== */

describe('normaliseTagList', () => {
  it('passes a clean list through', () => {
    expect(normaliseTagList('ai agent, langchain, python')).toBe('ai agent, langchain, python');
  });

  it('strips a leading label a model added anyway', () => {
    // The prompt asks for a bare list, but "Here are your tags:" would otherwise
    // become a tag the moment the user pastes it into Studio.
    expect(normaliseTagList('Tags: ai agent, langchain')).toBe('ai agent, langchain');
    expect(normaliseTagList('Here are the tags: ai agent, langchain')).toBe('ai agent, langchain');
  });

  it('strips code fences', () => {
    expect(normaliseTagList('```\nai agent, langchain\n```')).toBe('ai agent, langchain');
  });

  it('strips list bullets and numbering', () => {
    expect(normaliseTagList('- ai agent, * langchain, 1. python')).toBe(
      'ai agent, langchain, python',
    );
  });

  it('strips hash prefixes, which are not valid tags', () => {
    expect(normaliseTagList('#aiagent, #langchain')).toBe('aiagent, langchain');
  });

  it('de-duplicates case-insensitively, keeping first-seen order', () => {
    // Studio silently drops duplicates, which reads as data loss.
    expect(normaliseTagList('AI Agent, ai agent, LangChain, ai agent')).toBe('AI Agent, LangChain');
  });

  it("stops short of YouTube's tag character budget", () => {
    const many = Array.from({ length: 200 }, (_, index) => `tag-number-${index}`).join(', ');
    const result = normaliseTagList(many);

    expect(result.length).toBeLessThanOrEqual(460);
    // Truncation happens on a tag boundary, never mid-tag.
    expect(result.endsWith(',')).toBe(false);
    expect(result.split(', ').every((tag) => /^tag-number-\d+$/.test(tag))).toBe(true);
  });

  it('drops empty entries from trailing or doubled commas', () => {
    expect(normaliseTagList('ai agent,, langchain,')).toBe('ai agent, langchain');
  });

  it('returns an empty string for output with no usable tags', () => {
    expect(normaliseTagList('')).toBe('');
    expect(normaliseTagList('   ')).toBe('');
  });
});
