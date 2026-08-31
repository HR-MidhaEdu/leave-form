/**
 * Google Apps Script backend for the Leave & Task Handover form.
 *
 * Deploy as a Web app (execute as you; access: anyone), then use its URL in
 * index.html -> CONFIG.SHEETS_WEBHOOK_URL.
 */

const HR_EMAIL = 'hr@midha.in';
const ORG_NAME = 'Midha Education Private Limited';
const RESPONSE_SHEET = 'Task Responses';
const SUBMISSION_SHEET = 'Leave Submissions';
const BACKEND_VERSION = '2026-08-31-v2';

/** Run this once from the Apps Script editor to authorize and verify Gmail. */
function testEmailSetup() {
  const recipient = Session.getEffectiveUser().getEmail();
  if (!recipient) throw new Error('Apps Script could not determine the executing account email.');
  GmailApp.sendEmail(
    recipient,
    '[Leave form test] Gmail setup is working',
    'Backend ' + BACKEND_VERSION + ' can send email successfully.'
  );
  console.log('Test email sent to ' + recipient);
}

function doPost(e) {
  try {
    const data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (data.type !== 'leave_submission') throw new Error('Unsupported request type');
    processSubmission_(data);
    return json_({ok: true});
  } catch (error) {
    console.error(error);
    return json_({ok: false, error: String(error.message || error)});
  }
}

function doGet(e) {
  const params = (e && e.parameter) || {};
  if (params.action !== 'respond') {
    return responsePage_(
      'Leave form backend',
      'Backend version ' + BACKEND_VERSION + ' is deployed and ready.',
      true
    );
  }
  return recordResponse_(params.task_id, params.response);
}

function processSubmission_(data) {
  if (!data.submission_id || !data.emp_name || !data.emp_email) {
    throw new Error('Missing submission details');
  }

  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const groups = {};
  tasks.forEach(function(task, index) {
    const email = String(task.assignee_email || '').trim().toLowerCase();
    if (!task.task || !email) return;
    if (!groups[email]) {
      groups[email] = {name: task.assignee_name || email, email: email, tasks: []};
    }
    groups[email].tasks.push({
      id: data.submission_id + '-' + (task.row_id || index + 1),
      description: String(task.task)
    });
  });

  const props = PropertiesService.getScriptProperties();
  if (Object.keys(groups).length === 0) {
    GmailApp.sendEmail(
      HR_EMAIL,
      '[Leave request] ' + data.emp_name + ' — ' + data.leave_from + ' to ' + data.leave_to,
      data.emp_name + ' (' + data.emp_email + ') submitted a ' + (data.leave_type || '') +
        ' leave request from ' + data.leave_from + ' to ' + data.leave_to + '.\n\nReason: ' +
        (data.reason || 'Not provided') + '\n\nNo task handovers were included.'
    );
  }
  Object.keys(groups).forEach(function(email) {
    const group = groups[email];
    const subject = '[Task handover] ' + data.emp_name + ' — ' + data.leave_from + ' to ' + data.leave_to;
    const storedTasks = group.tasks.map(function(task) {
      const state = {
        task_id: task.id,
        submission_id: data.submission_id,
        description: task.description,
        assignee_name: group.name,
        assignee_email: group.email,
        employee_name: data.emp_name,
        employee_email: data.emp_email,
        status: 'pending',
        thread_id: '',
        message_id: '',
        backend_version: BACKEND_VERSION
      };
      props.setProperty(taskKey_(task.id), JSON.stringify(state));
      return state;
    });

    // Creating a draft first gives us the sent Gmail message and its thread ID.
    const message = GmailApp.createDraft(group.email, subject, assignmentText_(data, group), {
      htmlBody: assignmentHtml_(data, group),
      name: ORG_NAME,
      cc: uniqueEmails_([HR_EMAIL, data.emp_email]).join(',')
    }).send();
    const threadId = message.getThread().getId();
    const messageId = message.getId();

    storedTasks.forEach(function(state) {
      state.thread_id = threadId;
      state.message_id = messageId;
      props.setProperty(taskKey_(state.task_id), JSON.stringify(state));
    });
  });

  appendRow_(SUBMISSION_SHEET, [
    new Date(), data.submission_id, data.emp_name, data.emp_email, data.emp_role || '',
    data.leave_from || '', data.leave_to || '', data.leave_days || '', data.leave_type || '',
    data.reason || '', data.contact_ok || '', JSON.stringify(tasks)
  ], ['Timestamp','Submission ID','Employee','Employee email','Role','Leave from','Leave to','Days','Type','Reason','Contact allowed','Tasks']);
}

function recordResponse_(taskId, response) {
  response = String(response || '').toLowerCase();
  if (!taskId || ['accepted', 'declined'].indexOf(response) === -1) {
    return responsePage_('Invalid response', 'This response link is not valid.', false);
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let state;
  try {
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty(taskKey_(taskId));
    if (!raw) {
      return responsePage_('Task not found', 'This task link has expired or is invalid.', false);
    }
    state = JSON.parse(raw);
    if (state.status !== 'pending') {
      return responsePage_(
        'Already responded',
        'You already ' + state.status + ' this task. Your first response is final.',
        false
      );
    }
    state.status = response;
    state.responded_at = new Date().toISOString();
    props.setProperty(taskKey_(taskId), JSON.stringify(state));
  } finally {
    lock.releaseLock();
  }

  appendRow_(RESPONSE_SHEET, [
    new Date(), state.submission_id, state.task_id, state.employee_name,
    state.assignee_name, state.assignee_email, state.description, response
  ], ['Timestamp','Submission ID','Task ID','Employee','Assignee','Assignee email','Task','Response']);

  const verb = response === 'accepted' ? 'accepted' : 'declined';
  const reply = state.assignee_name + ' ' + verb + ' this task:\n\n' + state.description +
    '\n\nThis response is final and the task cannot be answered again.';
  const originalMessage = state.message_id && GmailApp.getMessageById(state.message_id);
  const thread = !originalMessage && state.thread_id && GmailApp.getThreadById(state.thread_id);
  if (originalMessage) {
    // Reply to the exact assignment message, not whichever message happens to
    // be last in the thread. This preserves the original Message-ID chain.
    originalMessage.replyAll(reply);
  } else if (thread) {
    thread.replyAll(reply);
  } else {
    GmailApp.sendEmail(
      uniqueEmails_([HR_EMAIL, state.employee_email]).join(','),
      '[Task handover response] ' + state.assignee_name + ' ' + verb,
      reply
    );
  }

  return responsePage_(
    'Response recorded',
    'You have ' + verb + ' the task. This response is final.',
    true
  );
}

function assignmentHtml_(data, group) {
  const appUrl = ScriptApp.getService().getUrl();
  const taskRows = group.tasks.map(function(task) {
    const accept = appUrl + '?action=respond&task_id=' + encodeURIComponent(task.id) + '&response=accepted';
    const decline = appUrl + '?action=respond&task_id=' + encodeURIComponent(task.id) + '&response=declined';
    return '<div style="margin:18px 0;padding:16px;border:1px solid #ddd;border-radius:8px">' +
      '<div style="margin-bottom:14px;white-space:pre-wrap">' + escapeHtml_(task.description) + '</div>' +
      '<a href="' + accept + '" style="display:inline-block;background:#0B5D47;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;margin-right:8px">Accept</a>' +
      '<a href="' + decline + '" style="display:inline-block;background:#a32d2d;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px">Decline</a>' +
      '</div>';
  }).join('');

  return '<div style="font-family:Arial,sans-serif;max-width:680px;color:#222">' +
    '<h2>Task handover request</h2><p>Hello ' + escapeHtml_(group.name) + ',</p>' +
    '<p><strong>' + escapeHtml_(data.emp_name) + '</strong> will be on leave from ' +
    escapeHtml_(data.leave_from) + ' to ' + escapeHtml_(data.leave_to) +
    '. Please respond once to each task below.</p>' + taskRows +
    '<p style="color:#666;font-size:13px">Your first Accept or Decline selection for each task is final. All updates will remain in this email thread.</p>' +
    '</div>';
}

function assignmentText_(data, group) {
  return 'Hello ' + group.name + ',\n\n' + data.emp_name + ' will be on leave from ' +
    data.leave_from + ' to ' + data.leave_to +
    '. Open the HTML version of this email to accept or decline each assigned task.';
}

function responsePage_(title, message, success) {
  const color = success ? '#0B5D47' : '#8a3b12';
  return HtmlService.createHtmlOutput(
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<div style="font-family:Arial,sans-serif;max-width:560px;margin:70px auto;padding:30px;border:1px solid #ddd;border-radius:12px">' +
    '<h2 style="color:' + color + '">' + escapeHtml_(title) + '</h2><p>' + escapeHtml_(message) + '</p></div>'
  ).setTitle(title);
}

function appendRow_(sheetName, row, headers) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) return;
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
    sheet.appendRow(headers);
  }
  sheet.appendRow(row);
}

function taskKey_(taskId) {
  return 'task:' + taskId;
}

function uniqueEmails_(emails) {
  return emails.filter(function(email, index, all) {
    return email && all.indexOf(email) === index;
  });
}

function escapeHtml_(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function(char) {
    return {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char];
  });
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
