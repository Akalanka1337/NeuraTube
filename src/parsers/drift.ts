/**
 * Schema drift detection.
 *
 * NeuraTube reads an undocumented, unversioned API. YouTube will rename a field
 * or add a category enum without notice, and when that happens there are only
 * two possible behaviours:
 *
 *   (a) show the user confidently wrong data, or
 *   (b) notice, and say so.
 *
 * (a) is the worse failure by a wide margin — a creator acting on a stale or
 * empty tag list makes a real decision on bad information. So every parser runs
 * through a collector that records which expected fields were absent and which
 * enum values it did not recognise, and the panel surfaces that instead of
 * pretending.
 *
 * This is also the early-warning system for the architectural risk noted in the
 * README: if Studio ever moves its InnerTube calls into a Web Worker, the
 * MAIN-world patch goes blind and there is no fallback API. That failure looks
 * exactly like "the expected fields stopped arriving".
 */

/** How badly the payload diverged from what we expect. */
export type DriftSeverity =
  /** Everything we need was present and understood. */
  | 'none'
  /** Unrecognised enum values, or optional fields missing. Data is usable. */
  | 'minor'
  /** Fields we rely on are missing. Data is partial and must be flagged. */
  | 'major'
  /** The payload did not parse, or contained nothing usable. */
  | 'broken';

export interface DriftReport {
  readonly severity: DriftSeverity;
  /** Dot-paths of expected fields that were absent. */
  readonly missingFields: readonly string[];
  /** Enum values with no entry in our maps. */
  readonly unmappedEnums: readonly { readonly field: string; readonly value: string }[];
  /** Items successfully parsed out of the payload. */
  readonly parsedCount: number;
  /** Human-readable summary, safe to show a user. */
  readonly summary: string;
}

/**
 * Fields whose absence means the data is not trustworthy.
 *
 * Deliberately short. `videoId` and `title` are what every downstream feature
 * assumes exist; `tags` absence is normal (plenty of videos have none), so it is
 * not listed — its absence is indistinguishable from an empty list, which is why
 * the parser tracks presence of the containing object instead.
 */
const CRITICAL_FIELDS: ReadonlySet<string> = new Set(['videoId', 'title']);

export interface DriftCollector {
  /** Record an expected field that was absent. */
  missing(path: string): void;
  /** Record an enum value we have no mapping for. */
  unmapped(field: string, value: string): void;
  /** Record a successfully parsed item. */
  counted(): void;
  /** Mark the whole payload unparseable. */
  fatal(reason: string): void;
  report(): DriftReport;
}

export function createDriftCollector(): DriftCollector {
  const missing = new Set<string>();
  const unmapped = new Map<string, string>();
  let parsed = 0;
  let fatalReason: string | null = null;

  return {
    missing(path) {
      missing.add(path);
    },
    unmapped(field, value) {
      // Keyed so a hundred videos in an unmapped category report once.
      unmapped.set(`${field}:${value}`, value);
    },
    counted() {
      parsed += 1;
    },
    fatal(reason) {
      fatalReason = reason;
    },
    report(): DriftReport {
      const missingFields = [...missing].sort();
      const unmappedEnums = [...unmapped.entries()]
        .map(([key, value]) => ({ field: key.slice(0, key.length - value.length - 1), value }))
        .sort((a, b) => a.field.localeCompare(b.field));

      let severity: DriftSeverity;
      if (fatalReason !== null || (parsed === 0 && missingFields.length > 0)) {
        severity = 'broken';
      } else if (missingFields.some((field) => CRITICAL_FIELDS.has(field))) {
        severity = 'major';
      } else if (missingFields.length > 0 || unmappedEnums.length > 0) {
        severity = 'minor';
      } else {
        severity = 'none';
      }

      return {
        severity,
        missingFields,
        unmappedEnums,
        parsedCount: parsed,
        summary: summarise(severity, missingFields, unmappedEnums, fatalReason),
      };
    },
  };
}

function summarise(
  severity: DriftSeverity,
  missingFields: readonly string[],
  unmappedEnums: readonly { field: string; value: string }[],
  fatalReason: string | null,
): string {
  switch (severity) {
    case 'none':
      return 'Payload matched the expected schema.';
    case 'minor': {
      const parts: string[] = [];
      if (unmappedEnums.length > 0) {
        parts.push(
          `${unmappedEnums.length} unrecognised value${unmappedEnums.length === 1 ? '' : 's'} (${unmappedEnums
            .slice(0, 3)
            .map((entry) => entry.value)
            .join(', ')})`,
        );
      }
      if (missingFields.length > 0) {
        parts.push(`${missingFields.length} optional field(s) absent`);
      }
      return `Minor schema drift: ${parts.join('; ')}. Data is usable.`;
    }
    case 'major':
      return `YouTube changed fields NeuraTube relies on (${missingFields.join(', ')}). Shown data is incomplete — check for an extension update.`;
    case 'broken':
      return fatalReason
        ? `Could not read Studio's response: ${fatalReason}. NeuraTube may need an update.`
        : "Studio's response contained nothing NeuraTube recognises. It may need an update.";
  }
}

/** Whether a report should be shown to the user rather than only logged. */
export function isUserVisible(report: DriftReport): boolean {
  return report.severity === 'major' || report.severity === 'broken';
}
