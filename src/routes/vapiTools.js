import { Router } from 'express';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { createLogger } from '../utils/logger.js';
import { sendMessage } from '../services/telegram.js';
import { searchMemoriesPgvector } from '../services/pgvector.js';
import { createReminder } from '../services/reminderScheduler.js';

const router = Router();
const logger = createLogger('vapi-tools');

const COMPOSIO_API_URL = 'https://backend.composio.dev/api/v2';
const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY || process.env.RUBE_API_KEY;
const COMPOSIO_CALENDAR_ACCOUNT_ID = process.env.COMPOSIO_CALENDAR_ACCOUNT_ID;
const COMPOSIO_GMAIL_ACCOUNT_ID = process.env.COMPOSIO_GMAIL_ACCOUNT_ID;
const VAPI_SERVER_SECRET = process.env.VAPI_SERVER_SECRET;

const ASHLEY_TZ = 'America/Toronto';

// Ashley's calendars to query (primary + business calendars)
const CALENDAR_IDS = [
  'ash.cocktails@gmail.com',
  '866fb488b774383512064a7c7a9404c07c59e94bba90621bf64e8da0fd67a3f7@group.calendar.google.com',
  'f7ea264384d41207c299be419cc98efcaaa1ec6ccfa10854e2f4446d9f417e29@group.calendar.google.com',
  'c_749cd4153a2f84021fb73f9b12b43d6643e265a6577d9e79451c0df584f3b138@group.calendar.google.com',
];

/**
 * POST /vapi/tools - Handle Vapi server-side tool calls
 */
router.post('/tools', async (req, res) => {
  // Auth: validate x-vapi-secret header if present
  const providedSecret = req.headers['x-vapi-secret'] || '';
  if (providedSecret) {
    if (!VAPI_SERVER_SECRET || !timingSafeEqual(providedSecret, VAPI_SERVER_SECRET)) {
      logger.warn('Unauthorized Vapi tool call attempt (bad secret)');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } else {
    logger.info('Vapi tool call without secret header (Vapi may not send it)');
  }

  const toolCallList = req.body?.message?.toolCallList;
  if (!Array.isArray(toolCallList) || toolCallList.length === 0) {
    return res.status(400).json({ error: 'No tool calls in request' });
  }

  const results = [];

  for (const toolCall of toolCallList) {
    const funcName = toolCall.function?.name;
    const args = toolCall.function?.arguments || {};
    const callId = toolCall.id;
    const start = Date.now();

    let result;
    try {
      switch (funcName) {
        case 'take_message':
          result = await handleTakeMessage(args);
          break;
        case 'lookup_emails':
          result = await handleLookupEmails(args);
          break;
        case 'check_calendar':
          result = await handleCheckCalendar(args);
          break;
        case 'list_tasks':
          result = await handleListTasks(args);
          break;
        case 'search_memory':
          result = await handleSearchMemory(args);
          break;
        case 'create_reminder':
          result = await handleCreateReminder(args);
          break;
        case 'move_event':
          result = await handleMoveEvent(args);
          break;
        case 'create_event':
          result = await handleCreateEvent(args);
          break;
        case 'create_task':
          result = await handleCreateTask(args);
          break;
        default:
          result = "Sorry, I don't know how to do that yet.";
          logger.warn({ funcName }, 'Unknown Vapi tool function');
      }
    } catch (error) {
      logger.error({ error, funcName }, 'Tool handler failed');
      result = 'Sorry, something went wrong. Please try again.';
    }

    const elapsed = Date.now() - start;
    logger.info({ funcName, elapsed }, 'Vapi tool call processed');

    results.push({ name: funcName, toolCallId: callId, result });
  }

  res.json({ results });
});

/**
 * Timing-safe string comparison to prevent timing attacks
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) {
    // Still do a comparison to avoid leaking length info via timing
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(a));
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

/**
 * take_message - Client voicemail tool
 */
async function handleTakeMessage(args) {
  const { name, phone, message } = args;
  if (!name || !message) {
    return 'I need at least a name and a message to pass along.';
  }

  const phoneStr = phone ? ` (${phone})` : '';
  const text = `<b>New voicemail from ${escapeHtml(name)}${escapeHtml(phoneStr)}</b>\n\n${escapeHtml(message)}`;
  await sendMessage(text);

  return "Got it, I'll make sure Ashley gets your message right away.";
}

/**
 * lookup_emails - Personal tool (via Composio REST API)
 */
async function handleLookupEmails(args) {
  const maxResults = Math.min(Math.max(args.max_results || 5, 1), 10);
  const query = args.query || 'is:unread';

  if (!COMPOSIO_API_KEY || !COMPOSIO_GMAIL_ACCOUNT_ID) {
    return 'Email lookup is not configured right now.';
  }

  const resp = await composioExecute('GMAIL_FETCH_EMAILS', COMPOSIO_GMAIL_ACCOUNT_ID, {
    query,
    max_results: maxResults,
    ids_only: false,
    verbose: false
  });

  const messages = resp?.data?.messages || [];

  if (messages.length === 0) {
    return 'Your inbox is clear. No emails match that search.';
  }

  const summaries = messages.slice(0, maxResults).map(m => {
    const from = m.sender || m.from || 'someone';
    const subject = m.subject || 'no subject';
    const senderName = from.replace(/<[^>]+>/, '').trim() || from;
    return `From ${senderName} about ${subject}`;
  });

  let response = `You have ${messages.length} email${messages.length !== 1 ? 's' : ''} matching that search. `;
  response += summaries.join('. ') + '.';

  return response;
}

/**
 * check_calendar - Personal tool (via Composio REST API)
 * Queries multiple calendars in parallel for a unified view.
 */
async function handleCheckCalendar(args) {
  const dateArg = (args.date || 'today').toLowerCase().trim();

  if (!COMPOSIO_API_KEY || !COMPOSIO_CALENDAR_ACCOUNT_ID) {
    return 'Calendar is not configured right now.';
  }

  // All date math in Ashley's timezone (EST/EDT)
  const { todayStr, dayOfWeek } = getEstToday();
  let startDateStr, endDateStr, rangeLabel;

  if (dateArg === 'this week') {
    startDateStr = todayStr;
    endDateStr = addDays(todayStr, 7 - dayOfWeek);
    rangeLabel = 'This week';
  } else if (dateArg === 'next week') {
    startDateStr = addDays(todayStr, 7 - dayOfWeek + 1);
    endDateStr = addDays(startDateStr, 6);
    rangeLabel = 'Next week';
  } else {
    let targetStr;
    if (dateArg === 'today') {
      targetStr = todayStr;
      rangeLabel = 'Today';
    } else if (dateArg === 'tomorrow') {
      targetStr = addDays(todayStr, 1);
      rangeLabel = 'Tomorrow';
    } else {
      const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const dayIndex = dayNames.indexOf(dateArg);
      if (dayIndex >= 0) {
        const daysAhead = (dayIndex - dayOfWeek + 7) % 7 || 7;
        targetStr = addDays(todayStr, daysAhead);
        rangeLabel = dateArg.charAt(0).toUpperCase() + dateArg.slice(1);
      } else {
        // Try as a date string
        const parsed = new Date(dateArg);
        targetStr = isNaN(parsed.getTime()) ? todayStr : dateArg;
        rangeLabel = formatDateLabel(new Date(targetStr + 'T12:00:00'));
      }
    }
    startDateStr = targetStr;
    endDateStr = targetStr;
  }

  const tzSuffix = getEstOffsetStr();
  const timeMin = `${startDateStr}T00:00:00${tzSuffix}`;
  const timeMax = `${endDateStr}T23:59:59${tzSuffix}`;

  // Query all calendars in parallel
  const calendarResults = await Promise.allSettled(
    CALENDAR_IDS.map(calId =>
      composioExecute('GOOGLECALENDAR_EVENTS_LIST', COMPOSIO_CALENDAR_ACCOUNT_ID, {
        calendarId: calId,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 20
      })
    )
  );

  // Merge events from all calendars, deduplicate by summary + start time
  const seen = new Set();
  const events = [];
  for (const result of calendarResults) {
    if (result.status !== 'fulfilled') continue;
    const items = result.value?.data?.items || [];
    for (const e of items) {
      const dedupKey = `${(e.summary || '').trim().toLowerCase()}|${e.start?.dateTime || e.start?.date || ''}`;
      if (!seen.has(dedupKey)) {
        seen.add(dedupKey);
        events.push(e);
      }
    }
  }

  // Sort by start time
  events.sort((a, b) => {
    const aTime = new Date(a.start?.dateTime || a.start?.date || 0);
    const bTime = new Date(b.start?.dateTime || b.start?.date || 0);
    return aTime - bTime;
  });

  if (events.length === 0) {
    return `${rangeLabel} your calendar is clear. Nothing scheduled.`;
  }

  // For multi-day ranges, group by day
  const isRange = dateArg === 'this week' || dateArg === 'next week';
  if (isRange) {
    const byDay = {};
    for (const e of events) {
      const start = new Date(e.start?.dateTime || e.start?.date);
      const dayKey = start.toLocaleDateString('en-US', { weekday: 'long', timeZone: ASHLEY_TZ });
      if (!byDay[dayKey]) byDay[dayKey] = [];
      byDay[dayKey].push(e);
    }

    let result = `${rangeLabel} you have ${events.length} event${events.length !== 1 ? 's' : ''}. `;
    const dayParts = Object.entries(byDay).slice(0, 5).map(([day, dayEvents]) => {
      const items = dayEvents.slice(0, 3).map(e => {
        const summary = e.summary || 'Untitled';
        const time = formatEventTimeVoice(e);
        return time ? `${summary} at ${time}` : summary;
      });
      return `${day}: ${items.join(', ')}`;
    });
    result += dayParts.join('. ') + '.';
    return result;
  }

  // Single day
  let result = `${rangeLabel} you have ${events.length} event${events.length !== 1 ? 's' : ''}. `;
  const eventParts = events.slice(0, 5).map(e => {
    const summary = e.summary || 'Untitled event';
    const time = formatEventTimeVoice(e);
    return time ? `${summary} at ${time}` : summary;
  });
  result += eventParts.join('. ') + '.';

  return result;
}

/**
 * list_tasks - Personal tool
 */
async function handleListTasks(args) {
  const status = args.status || 'assigned_to_max';
  const limit = Math.min(Math.max(args.limit || 5, 1), 10);

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const { data, error } = await supabase
    .from('tasks')
    .select('title, status, priority')
    .eq('status', status)
    .order('priority', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error({ error }, 'Failed to query tasks');
    return 'I had trouble checking the task list. Try again in a moment.';
  }

  if (!data || data.length === 0) {
    return 'No tasks right now.';
  }

  let result = `You have ${data.length} task${data.length !== 1 ? 's' : ''}. `;
  const taskParts = data.map(t => t.title);
  result += taskParts.join('. ') + '.';

  return result;
}

/**
 * search_memory - Personal tool
 */
async function handleSearchMemory(args) {
  const query = args.query;
  if (!query) {
    return 'What would you like me to look up?';
  }

  // Try vector search first (requires Ollama for embeddings)
  const results = await searchMemoriesPgvector(query, 0.6, 5);

  if (results && results.length > 0) {
    const bullets = results.slice(0, 3).map(r => r.content);
    return "Here's what I know. " + bullets.join('. ') + '.';
  }

  // Fallback: text-based search when embeddings unavailable (Railway has no Ollama)
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const words = query.split(/\s+/).filter(w => w.length > 2).slice(0, 5);
  const orFilter = words.map(w => `content.ilike.%${w}%`).join(',');

  let builder = supabase.from('memory').select('content').or(orFilter).limit(5);

  const { data, error } = await builder;
  if (error || !data || data.length === 0) {
    return "I don't have anything on that.";
  }

  const bullets = data.slice(0, 3).map(r => r.content);
  return "Here's what I know. " + bullets.join('. ') + '.';
}

/**
 * create_reminder - Personal tool
 */
async function handleCreateReminder(args) {
  const { message, time } = args;
  if (!message || !time) {
    return 'I need to know what to remind you about and when.';
  }

  const scheduledFor = parseNaturalTime(time);
  if (!scheduledFor) {
    return "I couldn't figure out that time. Try something like 3pm, in 30 minutes, or tomorrow at 9am.";
  }

  if (scheduledFor <= new Date()) {
    return "That time has already passed. Give me a future time.";
  }

  const reminder = await createReminder(message, scheduledFor);

  const timeStr = scheduledFor.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: ASHLEY_TZ
  });

  return `Done. I'll call you at ${timeStr} to remind you: ${message}.`;
}

/**
 * Parse natural language time into a UTC Date, interpreting times in Ashley's timezone.
 * Railway runs in UTC, so "2:30pm" means 2:30 PM EST, not 2:30 PM UTC.
 * Handles: "3pm", "3:30pm", "15:00", "in 30 minutes", "in 2 hours",
 *          "tomorrow at 9am", "tomorrow at 9:30"
 */
function parseNaturalTime(timeStr) {
  const now = new Date();
  const lower = timeStr.toLowerCase().trim();

  // "in X minutes/hours" - relative times are timezone-agnostic
  const relativeMatch = lower.match(/^in\s+(\d+)\s*(min(?:ute)?s?|hours?|hrs?)$/);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2];
    const result = new Date(now);
    if (unit.startsWith('min')) {
      result.setMinutes(result.getMinutes() + amount);
    } else {
      result.setHours(result.getHours() + amount);
    }
    return result;
  }

  // Get today's date in Ashley's timezone
  const { todayStr } = getEstToday();
  let baseDateStr = todayStr;
  let remaining = lower;

  if (lower.startsWith('tomorrow')) {
    baseDateStr = addDays(todayStr, 1);
    remaining = lower.replace(/^tomorrow\s*(at\s*)?/, '').trim();
  }

  // "3pm", "3:30pm", "15:00", "3:30 pm"
  const timeMatch = remaining.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2] || '0', 10);
    const meridiem = (timeMatch[3] || '').toLowerCase();

    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
    if (!meridiem && hours >= 1 && hours <= 7) hours += 12;

    // Build an ISO string in Ashley's timezone and convert to UTC
    const hh = String(hours).padStart(2, '0');
    const mm = String(minutes).padStart(2, '0');
    const tzOffset = getEstOffsetStr(); // e.g. "-05:00"
    const isoStr = `${baseDateStr}T${hh}:${mm}:00${tzOffset}`;
    return new Date(isoStr);
  }

  return null;
}

/**
 * move_event - Reschedule a calendar event to a new date/time.
 * Finds the event by name on the source date, then updates it.
 */
async function handleMoveEvent(args) {
  const { event_name, from_date, to_date, to_time } = args;
  if (!event_name || !to_date) {
    return 'I need at least the event name and the new date to move it to.';
  }
  if (!COMPOSIO_API_KEY || !COMPOSIO_CALENDAR_ACCOUNT_ID) {
    return 'Calendar is not configured right now.';
  }

  // Resolve source date
  const sourceDate = resolveDate(from_date || 'today');
  const tzSuffix = getEstOffsetStr();
  const timeMin = `${sourceDate}T00:00:00${tzSuffix}`;
  const timeMax = `${sourceDate}T23:59:59${tzSuffix}`;

  // Find the event across all calendars
  const calendarResults = await Promise.allSettled(
    CALENDAR_IDS.map(calId =>
      composioExecute('GOOGLECALENDAR_EVENTS_LIST', COMPOSIO_CALENDAR_ACCOUNT_ID, {
        calendarId: calId, timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 20
      }).then(resp => ({ calId, items: resp?.data?.items || [] }))
    )
  );

  // Find matching event (fuzzy name match)
  const searchName = event_name.toLowerCase();
  let found = null;
  for (const result of calendarResults) {
    if (result.status !== 'fulfilled') continue;
    const { calId, items } = result.value;
    for (const e of items) {
      if ((e.summary || '').toLowerCase().includes(searchName)) {
        found = { event: e, calendarId: calId };
        break;
      }
    }
    if (found) break;
  }

  if (!found) {
    return `I couldn't find an event matching "${event_name}" on ${sourceDate}. Can you double-check the name or date?`;
  }

  // Calculate duration from original event
  const origStart = new Date(found.event.start?.dateTime || found.event.start?.date);
  const origEnd = new Date(found.event.end?.dateTime || found.event.end?.date);
  const durationMs = origEnd - origStart;
  const durationHours = Math.floor(durationMs / 3600000);
  const durationMinutes = Math.floor((durationMs % 3600000) / 60000);

  // Resolve target date and time
  const targetDate = resolveDate(to_date);
  let targetTime = to_time;
  if (!targetTime) {
    // Keep the same time as the original
    targetTime = origStart.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: ASHLEY_TZ });
  }
  const parsedTime = parseTimeStr(targetTime);
  if (!parsedTime) {
    return "I couldn't figure out that time. Try something like 10am, 2:30pm, or 15:00.";
  }

  const newStartDatetime = `${targetDate}T${parsedTime}:00`;

  const updateResp = await composioExecute('GOOGLECALENDAR_UPDATE_EVENT', COMPOSIO_CALENDAR_ACCOUNT_ID, {
    event_id: found.event.id,
    calendar_id: found.calendarId,
    start_datetime: newStartDatetime,
    timezone: ASHLEY_TZ,
    summary: found.event.summary,
    event_duration_hour: durationHours,
    event_duration_minutes: durationMinutes,
    send_updates: false
  });

  if (!updateResp) {
    return 'I found the event but had trouble moving it. You might need to do it manually.';
  }

  const newTimeStr = new Date(`${newStartDatetime}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `Done. I moved ${found.event.summary} to ${targetDate} at ${newTimeStr}.`;
}

/**
 * create_event - Create a new calendar event.
 */
async function handleCreateEvent(args) {
  const { summary, date, time, duration_hours, duration_minutes, description, location } = args;
  if (!summary || !date) {
    return 'I need at least the event name and date to create it.';
  }
  if (!COMPOSIO_API_KEY || !COMPOSIO_CALENDAR_ACCOUNT_ID) {
    return 'Calendar is not configured right now.';
  }

  const targetDate = resolveDate(date);
  const targetTime = time ? parseTimeStr(time) : '09:00';
  if (!targetTime) {
    return "I couldn't figure out that time. Try something like 10am, 2:30pm, or 15:00.";
  }

  const startDatetime = `${targetDate}T${targetTime}:00`;

  const input = {
    summary,
    start_datetime: startDatetime,
    timezone: ASHLEY_TZ,
    calendar_id: 'primary',
    event_duration_hour: duration_hours || 1,
    event_duration_minutes: duration_minutes || 0,
    send_updates: false,
    exclude_organizer: true
  };
  if (description) input.description = description;
  if (location) input.location = location;

  const resp = await composioExecute('GOOGLECALENDAR_CREATE_EVENT', COMPOSIO_CALENDAR_ACCOUNT_ID, input);
  if (!resp) {
    return 'I had trouble creating that event. You might need to add it manually.';
  }

  const timeStr = new Date(startDatetime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `Done. I created "${summary}" on ${targetDate} at ${timeStr}.`;
}

/**
 * create_task - Create a new task in Supabase.
 */
async function handleCreateTask(args) {
  const { title, description, priority } = args;
  if (!title) {
    return 'I need at least a title for the task.';
  }

  const DEFAULT_USER_ID = process.env.USER_ID || '3ed111ff-c28f-4cda-b987-1afa4f7eb081';
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data, error } = await supabase
    .from('tasks')
    .insert({
      title,
      description: description || null,
      status: 'assigned_to_max',
      priority: priority || 'medium',
      task_type: 'plan',
      assigned_to: 'max',
      user_id: DEFAULT_USER_ID
    })
    .select('id')
    .single();

  if (error) {
    logger.error({ error }, 'Failed to create task');
    return 'I had trouble adding that task. Try again in a moment.';
  }

  return `Got it. I added "${title}" to the task list.`;
}

/**
 * Resolve natural language date to YYYY-MM-DD string.
 */
function resolveDate(dateArg) {
  const lower = (dateArg || 'today').toLowerCase().trim();
  const { todayStr, dayOfWeek } = getEstToday();

  if (lower === 'today') return todayStr;
  if (lower === 'tomorrow') return addDays(todayStr, 1);

  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayIndex = dayNames.indexOf(lower);
  if (dayIndex >= 0) {
    const daysAhead = (dayIndex - dayOfWeek + 7) % 7 || 7;
    return addDays(todayStr, daysAhead);
  }

  // Try as ISO date
  const parsed = new Date(lower);
  if (!isNaN(parsed.getTime())) return lower.slice(0, 10);

  return todayStr;
}

/**
 * Parse time string to HH:MM format.
 * Handles: "3pm", "3:30pm", "15:00", "10 am", "noon"
 */
function parseTimeStr(str) {
  if (!str) return null;
  const lower = str.toLowerCase().trim();
  if (lower === 'noon') return '12:00';
  if (lower === 'midnight') return '00:00';

  const m = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;

  let hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2] || '0', 10);
  const meridiem = (m[3] || '').toLowerCase();

  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;
  if (!meridiem && hours >= 1 && hours <= 7) hours += 12; // assume PM for business hours

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Composio API helper
// ---------------------------------------------------------------------------

/**
 * Execute a Composio action via their REST API.
 * Replaces the dead Rube HTTP endpoint.
 */
async function composioExecute(actionName, connectedAccountId, input) {
  const resp = await fetch(`${COMPOSIO_API_URL}/actions/${actionName}/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': COMPOSIO_API_KEY
    },
    body: JSON.stringify({ connectedAccountId, input })
  });

  const data = await resp.json();

  if (!resp.ok || data.error) {
    logger.error({ actionName, status: resp.status, error: data.error || data.message }, 'Composio API error');
    return null;
  }

  return data;
}

/**
 * Get today's date and day-of-week in Ashley's timezone.
 */
function getEstToday() {
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: ASHLEY_TZ }); // "2026-02-16"
  const dayName = now.toLocaleDateString('en-US', { timeZone: ASHLEY_TZ, weekday: 'long' }).toLowerCase();
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return { todayStr, dayOfWeek: dayNames.indexOf(dayName) };
}

/**
 * Add days to a date string "YYYY-MM-DD", return new date string.
 */
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z'); // noon to avoid DST edge
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Get current EST/EDT offset string like "-05:00" or "-04:00".
 */
function getEstOffsetStr() {
  const now = new Date();
  const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC', hour12: false });
  const estStr = now.toLocaleString('en-US', { timeZone: ASHLEY_TZ, hour12: false });
  const utcDate = new Date(utcStr);
  const estDate = new Date(estStr);
  const diffHours = Math.round((estDate - utcDate) / 3600000);
  const sign = diffHours >= 0 ? '+' : '-';
  const absH = String(Math.abs(diffHours)).padStart(2, '0');
  return `${sign}${absH}:00`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatDateLabel(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  });
}

function formatEventTimeVoice(event) {
  if (!event.start) return null;
  // All-day events have start.date but no start.dateTime
  if (event.start.date && !event.start.dateTime) return null;
  const start = new Date(event.start.dateTime);
  return start.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: ASHLEY_TZ
  });
}

export default router;
