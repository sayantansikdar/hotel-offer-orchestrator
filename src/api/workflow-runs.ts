import { WorkflowNotFoundError, type Client, type WorkflowHandle } from '@temporalio/client';
import { defaultPayloadConverter } from '@temporalio/common';
import type { HotelOffer, HotelOffersResult } from '../types';

// Read-only views of the workflow runs, so the web console can show what the
// Temporal UI shows without exposing the Temporal server itself.

type History = Awaited<ReturnType<WorkflowHandle['fetchHistory']>>;
type HistoryEvent = NonNullable<History['events']>[number];
type Payloads = NonNullable<HistoryEvent['workflowExecutionStartedEventAttributes']>['input'];

const WORKFLOW_ID = /^hotel-offers-([a-z][a-z .-]{0,49})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isHotelOffersWorkflowId(id: string): boolean {
  return WORKFLOW_ID.test(id);
}

function cityOf(workflowId: string): string {
  return WORKFLOW_ID.exec(workflowId)?.[1] ?? '';
}

export interface WorkflowRunSummary {
  workflowId: string;
  runId: string;
  city: string;
  status: string;
  startTime: string;
  closeTime?: string;
  durationMs?: number;
}

export async function listWorkflowRuns(client: Client, limit: number): Promise<WorkflowRunSummary[]> {
  const runs: WorkflowRunSummary[] = [];
  for await (const run of client.workflow.list({ query: "WorkflowType = 'hotelOffersWorkflow'", pageSize: limit })) {
    runs.push({
      workflowId: run.workflowId,
      runId: run.runId,
      city: cityOf(run.workflowId),
      status: run.status.name,
      startTime: run.startTime.toISOString(),
      closeTime: run.closeTime?.toISOString(),
      durationMs: run.closeTime ? run.closeTime.getTime() - run.startTime.getTime() : undefined,
    });
    if (runs.length >= limit) break;
  }
  return runs;
}

export type TimelineTone = 'neutral' | 'ok' | 'warn' | 'error';

export interface TimelineEvent {
  id: number;
  time: string;
  /** Milliseconds since the workflow started. */
  offsetMs: number;
  type: string;
  title: string;
  detail?: string;
  tone: TimelineTone;
  /** Activity label, set on activity events so a client can group them into lanes. */
  activity?: string;
}

export interface WorkflowRunDetail extends WorkflowRunSummary {
  events: TimelineEvent[];
  result?: { hotels: number; suppliers: HotelOffersResult['suppliers']; cached: boolean };
  failure?: string;
}

function decode<T>(payloads: Payloads): T[] {
  return (payloads?.payloads ?? []).map((p) => defaultPayloadConverter.fromPayload<T>(p));
}

function timeMs(event: HistoryEvent): number {
  const ts = event.eventTime;
  return ts ? Number(ts.seconds ?? 0) * 1000 + Math.round((ts.nanos ?? 0) / 1e6) : 0;
}

function activityLabel(name: string, args: unknown[]): string {
  if (name === 'fetchSupplierHotels') return `Fetch Supplier ${String(args[0])}`;
  if (name === 'cacheHotelOffers') return 'Cache offers in Redis';
  return name;
}

/** Turns raw Temporal history into a short, human-readable timeline. */
export function toTimeline(events: HistoryEvent[]): Omit<WorkflowRunDetail, keyof WorkflowRunSummary> & { startMs: number } {
  const startMs = events.length ? timeMs(events[0]) : 0;
  const labels = new Map<number, { label: string; name: string }>();
  const timeline: TimelineEvent[] = [];
  let result: WorkflowRunDetail['result'];
  let failure: string | undefined;

  const push = (event: HistoryEvent, type: string, title: string, tone: TimelineTone, detail?: string, activity?: string) => {
    const ms = timeMs(event);
    timeline.push({
      id: Number(event.eventId ?? 0),
      time: new Date(ms).toISOString(),
      offsetMs: Math.max(0, ms - startMs),
      type,
      title,
      detail,
      tone,
      activity,
    });
  };

  for (const event of events) {
    const id = Number(event.eventId ?? 0);
    if (event.workflowExecutionStartedEventAttributes) {
      const [input] = decode<{ city: string }>(event.workflowExecutionStartedEventAttributes.input);
      push(event, 'WorkflowStarted', 'Workflow started', 'neutral', input ? `city = ${input.city}` : undefined);
    } else if (event.activityTaskScheduledEventAttributes) {
      const attrs = event.activityTaskScheduledEventAttributes;
      const name = attrs.activityType?.name ?? 'activity';
      const label = activityLabel(name, decode(attrs.input));
      labels.set(id, { label, name });
      push(event, 'ActivityScheduled', `${label} scheduled`, 'neutral', undefined, label);
    } else if (event.activityTaskStartedEventAttributes) {
      const attrs = event.activityTaskStartedEventAttributes;
      const { label } = labels.get(Number(attrs.scheduledEventId)) ?? { label: 'Activity' };
      const attempt = attrs.attempt ?? 1;
      const retried = attempt > 1;
      push(
        event,
        'ActivityStarted',
        retried ? `${label} — attempt ${attempt}` : `${label} started`,
        retried ? 'warn' : 'neutral',
        retried && attrs.lastFailure?.message ? `previous attempt: ${attrs.lastFailure.message}` : undefined,
        label,
      );
    } else if (event.activityTaskCompletedEventAttributes) {
      const attrs = event.activityTaskCompletedEventAttributes;
      const { label, name } = labels.get(Number(attrs.scheduledEventId)) ?? { label: 'Activity', name: '' };
      const [value] = decode<HotelOffer[] | undefined>(attrs.result);
      const detail = name === 'fetchSupplierHotels' && Array.isArray(value) ? `${value.length} hotels` : undefined;
      push(event, 'ActivityCompleted', `${label} completed`, 'ok', detail, label);
    } else if (event.activityTaskFailedEventAttributes) {
      const attrs = event.activityTaskFailedEventAttributes;
      const { label } = labels.get(Number(attrs.scheduledEventId)) ?? { label: 'Activity' };
      push(event, 'ActivityFailed', `${label} failed`, 'error', attrs.failure?.message ?? undefined, label);
    } else if (event.activityTaskTimedOutEventAttributes) {
      const attrs = event.activityTaskTimedOutEventAttributes;
      const { label } = labels.get(Number(attrs.scheduledEventId)) ?? { label: 'Activity' };
      push(event, 'ActivityTimedOut', `${label} timed out`, 'error', undefined, label);
    } else if (event.workflowExecutionCompletedEventAttributes) {
      const [value] = decode<HotelOffersResult>(event.workflowExecutionCompletedEventAttributes.result);
      if (value) result = { hotels: value.offers.length, suppliers: value.suppliers, cached: value.cached };
      push(event, 'WorkflowCompleted', 'Workflow completed', 'ok', value ? `${value.offers.length} best offers` : undefined);
    } else if (event.workflowExecutionFailedEventAttributes) {
      failure = event.workflowExecutionFailedEventAttributes.failure?.message ?? 'Workflow failed';
      push(event, 'WorkflowFailed', 'Workflow failed', 'error', failure);
    } else if (event.workflowExecutionTimedOutEventAttributes) {
      failure = 'Workflow timed out';
      push(event, 'WorkflowTimedOut', 'Workflow timed out', 'error');
    }
  }

  return { startMs, events: timeline, result, failure };
}

export async function getWorkflowRun(client: Client, workflowId: string): Promise<WorkflowRunDetail | null> {
  const handle = client.workflow.getHandle(workflowId);
  try {
    const [description, history] = await Promise.all([handle.describe(), handle.fetchHistory()]);
    const { events, result, failure } = toTimeline(history.events ?? []);
    return {
      workflowId,
      runId: description.runId,
      city: cityOf(workflowId),
      status: description.status.name,
      startTime: description.startTime.toISOString(),
      closeTime: description.closeTime?.toISOString(),
      durationMs: description.closeTime ? description.closeTime.getTime() - description.startTime.getTime() : undefined,
      events,
      result,
      failure,
    };
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) return null;
    throw err;
  }
}
