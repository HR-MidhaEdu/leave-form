# Deploy the task-response backend

The updated form no longer uses EmailJS. Google Apps Script sends the grouped
assignment emails, stores the first task response, and keeps notifications in
the original Gmail thread.

1. Open the Google Apps Script project behind the current webhook URL.
2. Replace its script with `Code.gs` from this folder.
3. Make sure the script is bound to the Google Sheet used by the leave form.
4. Choose **Deploy > Manage deployments**, open the existing deployment with
   the pencil icon, and select **New version**. Saving the editor alone does not
   update an existing `/exec` deployment.
5. Select **Web app**, execute as **Me**, and allow access to **Anyone**.
6. Authorize the Gmail and Google Sheets permissions when prompted.
7. If Apps Script gives you a different `/exec` URL, copy it into
   `CONFIG.SHEETS_WEBHOOK_URL` in `index.html`.
8. Open that `/exec` URL directly. It must display:
   **Backend version 2026-08-31-v2 is deployed and ready.** If it does not,
   the form is still calling an older deployment.

Test with two tasks assigned to the same email address. The assignee should
receive one email containing both tasks. After accepting or declining a task,
using either button for that same task again must show **Already responded**.
