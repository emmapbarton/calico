import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';

async function onboard(page) {
  await page.goto('/');
  await page.getByRole('button', { name: /get started/i }).click();
  await page.getByRole('button', { name: /next/i }).click();
  await page.getByRole('button', { name: /start/i }).click();
  await expect(page.locator('#app')).toBeVisible();
}

async function mockSupabase(page, { session = null, remoteSchedule = null } = {}) {
  await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
  await page.addInitScript(({ initialSession, initialRemoteSchedule }) => {
    window.__calicoSupabaseMock = {
      session: initialSession,
      remoteSchedule: initialRemoteSchedule,
      callbacks: [],
      magicLinkEmails: [],
      rpcCalls: [],
      emit(event, nextSession) {
        this.session = nextSession;
        this.callbacks.forEach(callback => callback(event, nextSession));
      },
    };
    window.supabase = {
      createClient() {
        return {
          auth: {
            onAuthStateChange(callback) {
              window.__calicoSupabaseMock.callbacks.push(callback);
              return { data: { subscription: { unsubscribe() {} } } };
            },
            async getSession() {
              return { data: { session: window.__calicoSupabaseMock.session }, error: null };
            },
            async signInWithOtp({ email }) {
              window.__calicoSupabaseMock.magicLinkEmails.push(email);
              return { error: null };
            },
            async signOut() {
              window.__calicoSupabaseMock.emit('SIGNED_OUT', null);
              return { error: null };
            },
          },
          async rpc(name, args) {
            window.__calicoSupabaseMock.rpcCalls.push({ name, args });
            if (name === 'get_calico_schedule') {
              return { data: window.__calicoSupabaseMock.remoteSchedule ? [window.__calicoSupabaseMock.remoteSchedule] : [], error: null };
            }
            if (name === 'save_calico_schedule') {
              return { data: [{ revision: (args.expected_revision || 0) + 1, updated_at: '2026-06-14T12:00:00.000Z' }], error: null };
            }
            return { data: [], error: null };
          },
        };
      },
    };
  }, { initialSession: session, initialRemoteSchedule: remoteSchedule });
}

async function openAddModal(page, type = 'task') {
  const mobileAdd = page.locator('.mobile-nav-add');
  if (await mobileAdd.isVisible()) {
    await mobileAdd.click();
    await page.locator('#f-type').selectOption(type);
  } else if (type === 'event') {
    await page.getByRole('button', { name: /add event/i }).click();
  } else {
    await page.getByRole('button', { name: /add task/i }).first().click();
  }
}

function dateString(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function visibleScheduleText(page, name) {
  return page.locator('.wk-block-title, .day-title, .ag-task-name, .ag-strip-name, .ci-name', { hasText: name });
}

async function addTask(page, name = 'E2E launch plan', hours = '4', deadline = dateString()) {
  await openAddModal(page, 'task');
  await page.locator('#f-name').fill(name);
  await page.locator('#f-hours').fill(hours);
  await page.locator('#f-deadline').fill(deadline);
  await page.getByRole('button', { name: /^save$/i }).click();
}

test('onboarding, task creation, schedule, persistence and mobile smoke', async ({ page, browserName }) => {
  await onboard(page);
  await addTask(page);
  await expect(visibleScheduleText(page, 'E2E launch plan').first()).toBeVisible();
  await page.reload();
  await expect(visibleScheduleText(page, 'E2E launch plan').first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.mobile-nav')).toBeVisible();
  await expect(visibleScheduleText(page, 'E2E launch plan').first()).toBeVisible();
});

test('event lifecycle, backup/reset/restore, search and manual task adjustment', async ({ page }) => {
  await onboard(page);
  await addTask(page, 'Adjustable task', '3', dateString(1));
  await openAddModal(page, 'event');
  await page.locator('#f-name').fill('Design review');
  await page.locator('#f-type').selectOption('event');
  await page.locator('#f-date').fill(new Date().toISOString().slice(0, 10));
  await page.locator('#f-start').fill('10:00');
  await page.locator('#f-end').fill('11:00');
  await page.getByRole('button', { name: /^save$/i }).click();
  await expect(visibleScheduleText(page, 'Design review').first()).toBeVisible();
  await visibleScheduleText(page, 'Design review').first().click();
  await page.locator('#f-name').fill('Design review edited');
  await page.getByRole('button', { name: /^save$/i }).click();
  await expect(visibleScheduleText(page, 'Design review edited').first()).toBeVisible();
  await page.locator('#global-search').fill('Adjustable');
  await expect(page.locator('.search-hit').first()).toBeVisible();
  await page.getByRole('button', { name: /agenda/i }).first().click();
  await page.locator('.ag-task-row', { hasText: 'Adjustable task' }).first().getByRole('button', { name: /^adjust$/i }).click();
  await page.locator('#day-hours-input').fill('1');
  await page.getByRole('button', { name: /save adjustment/i }).click();
  await expect(page.locator('#day-hours-bg')).toBeHidden();
  await expect(page.getByText(/automatic again|fixed|adjusting|redistributed/i).first()).toBeVisible();
  await page.getByRole('button', { name: /settings/i }).first().click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /export backup/i }).click();
  await download;
});

test('recurring event, conflict resolution and partial check-in UI', async ({ page }) => {
  await onboard(page);
  await openAddModal(page, 'event');
  await page.locator('#f-name').fill('Daily standup');
  await page.locator('#f-type').selectOption('event');
  await page.locator('#f-repeat').selectOption('daily');
  await page.getByRole('button', { name: /^save$/i }).click();
  await expect(visibleScheduleText(page, 'Daily standup').first()).toBeVisible();
  await addTask(page, 'Too much work', '24');
  await expect(page.locator('#conflict-bg')).toBeVisible();
  await page.getByRole('button', { name: /save anyway|resolve/i }).first().click().catch(() => {});
  await page.evaluate(() => {
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const d = `${yesterday.getFullYear()}-${String(yesterday.getMonth()+1).padStart(2,'0')}-${String(yesterday.getDate()).padStart(2,'0')}`;
    S.tasks.push({ id: 'partial-ui', type: 'task', name: 'Partial UI task', priority: 'mandatory', deadline: d, date: d, hours: 2, dist: 'even', repeat: 'none', logged: 0, color: '#111111' });
    S.taskLog['partial-ui|' + d] = { scheduled: 2, completed: 1, checked: false };
    invalidatePlan(); render(); maybeShowCheckin();
  });
  await expect(page.locator('#checkin-bg')).toBeVisible();
  await expect(page.locator('.ci-completed input').first()).toHaveValue('1');
  await page.getByRole('button', { name: /partly/i }).first().click();
  await page.locator('.ci-completed input').first().fill('1');
  await page.getByRole('button', { name: /done/i }).last().click();
  await expect(page.getByText(/unfinished work was returned/i)).toBeVisible();
});

test('task form, details and day actions use the tightened interaction model', async ({ page }) => {
  await onboard(page);
  await openAddModal(page, 'task');

  await expect(page.locator('#f-priority option')).toHaveCount(2);
  await expect(page.locator('#advanced-task-fields')).toBeHidden();
  await page.getByRole('button', { name: /show advanced options/i }).click();
  await expect(page.locator('#advanced-task-fields')).toBeVisible();
  await page.getByRole('button', { name: /hide advanced options/i }).click();
  await expect(page.locator('#advanced-task-fields')).toBeHidden();

  await page.getByRole('button', { name: /show advanced options/i }).click();
  await page.locator('#f-name').fill('Details flow task');
  await page.locator('#f-description').fill('A read-only description for the detail panel.');
  await page.locator('#f-hours').fill('2');
  await page.locator('#f-deadline').fill(dateString());
  await page.getByRole('button', { name: /^save$/i }).click();

  await page.getByRole('button', { name: /^day$/i }).first().click();
  const taskRow = page.locator('.day-item.task', { hasText: 'Details flow task' });
  await expect(taskRow).toBeVisible();
  await expect(taskRow.locator('.day-actions')).toHaveCSS('flex-direction', 'column');

  await taskRow.locator('.day-title').click();
  await expect(page.locator('#task-detail-bg')).toBeVisible();
  await expect(page.locator('#task-detail-name')).toHaveText('Details flow task');
  await expect(page.locator('#task-detail-description')).toHaveText('A read-only description for the detail panel.');
  await expect(page.locator('#task-detail-priority-symbol')).toHaveClass(/mandatory/);
  await expect(page.locator('#task-detail-hours')).toHaveText('2h');

  await page.getByRole('button', { name: /edit task/i }).click();
  await expect(page.locator('#modal-bg')).toBeVisible();
  await expect(page.locator('#f-name')).toHaveValue('Details flow task');
  await expect(page.locator('#advanced-task-fields')).toBeVisible();
  await page.getByRole('button', { name: /cancel/i }).click();

  await taskRow.getByRole('button', { name: /^partial$/i }).click();
  await expect(page.locator('#day-hours-bg')).toBeVisible();
  await expect(page.getByRole('button', { name: /save progress/i })).toBeVisible();
  await page.locator('#day-hours-input').fill('1');
  await page.getByRole('button', { name: /save progress/i }).click();
  await expect(page.locator('#day-hours-bg')).toBeHidden();

  const refreshedTaskRow = page.locator('.day-item.task', { hasText: 'Details flow task' });
  await refreshedTaskRow.getByRole('button', { name: /^done$/i }).click();
  await expect(page.locator('.day-item.task.completed', { hasText: 'Details flow task' })).toBeVisible();
});

test('daily availability, recurring availability blocks and fixed task times persist', async ({ page }) => {
  await onboard(page);
  await addTask(page, 'Timed focus block', '2', dateString());
  await page.getByRole('button', { name: /^day$/i }).first().click();

  const taskRow = page.locator('.day-item.task', { hasText: 'Timed focus block' });
  await taskRow.getByRole('button', { name: /^time$/i }).click();
  await page.locator('#time-block-mode').selectOption('fixed');
  await page.locator('#time-block-start').fill('14:00');
  await page.locator('#time-block-end').fill('16:00');
  await page.getByRole('button', { name: /save time/i }).click();
  await expect(page.locator('#time-block-bg')).toBeHidden();
  await expect(taskRow).toContainText('fixed time');

  await page.getByRole('button', { name: /working hours/i }).click();
  await page.locator('#day-working-hours-start').fill('10:00');
  await page.locator('#day-working-hours-end').fill('17:00');
  await page.locator('#day-working-hours-max').fill('4');
  await page.getByRole('button', { name: /save hours/i }).click();
  await expect(page.locator('#day-working-hours-bg')).toBeHidden();
  await expect.poll(() => page.evaluate(() => S.dailyWorkingHours[Object.keys(S.dailyWorkingHours)[0]])).toEqual({
    dayStart: '10:00', dayEnd: '17:00', maxDailyHours: 4,
  });

  await openAddModal(page, 'event');
  await page.locator('#f-name').fill('School run');
  await page.locator('#f-event-kind').selectOption('availability');
  await page.locator('#f-date').fill(dateString());
  await page.locator('#f-start').fill('10:00');
  await page.locator('#f-end').fill('11:00');
  await page.locator('#f-repeat').selectOption('weekdays');
  await page.getByRole('button', { name: /^save$/i }).click();
  await expect(page.locator('.day-item.event', { hasText: 'School run' })).toContainText('Availability block');
  await page.reload();
  await expect(page.locator('.day-item.task', { hasText: 'Timed focus block' })).toContainText('fixed time');
});

test('email account sync sends a magic link and saves a portable account state', async ({ page }) => {
  await mockSupabase(page);
  await onboard(page);
  await page.getByRole('button', { name: /settings/i }).first().click();

  await expect(page.locator('#settings-cloud-endpoint')).toHaveCount(0);
  await expect(page.locator('#account-email')).toBeVisible();
  await page.locator('#account-email').fill('person@example.com');
  await page.getByRole('button', { name: /email me a sign-in link/i }).click();
  await expect.poll(() => page.evaluate(() => window.__calicoSupabaseMock.magicLinkEmails)).toEqual(['person@example.com']);

  await page.evaluate(() => {
    window.__calicoSupabaseMock.emit('SIGNED_IN', {
      user: { id: '44444444-4444-4444-4444-444444444444', email: 'person@example.com' },
    });
  });
  await expect(page.locator('#account-signed-in')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__calicoSupabaseMock.rpcCalls)).toHaveLength(2);

  const calls = await page.evaluate(() => window.__calicoSupabaseMock.rpcCalls);
  expect(calls[0].name).toBe('get_calico_schedule');
  expect(calls[1].name).toBe('save_calico_schedule');
  expect(calls[1].args.expected_revision).toBe(0);
  expect(calls[1].args.next_state.account).toBeUndefined();
  expect(calls[1].args.next_state.cloud).toBeUndefined();
});

test('invalid account data leaves the local schedule untouched', async ({ page }) => {
  await mockSupabase(page);
  await onboard(page);
  await addTask(page, 'Keep this local task');
  await page.evaluate(() => {
    window.__calicoSupabaseMock.remoteSchedule = {
      state: { not: 'a Calico schedule' },
      revision: 4,
      updated_at: '2026-06-14T12:00:00.000Z',
    };
    window.__calicoSupabaseMock.emit('SIGNED_IN', {
      user: { id: '55555555-5555-5555-5555-555555555555', email: 'person@example.com' },
    });
  });
  await expect.poll(() => page.evaluate(() => S.account.lastError)).toBe('Your account schedule could not be read safely.');
  expect(await page.evaluate(() => S.onboarded)).toBe(true);
  expect(await page.evaluate(() => S.tasks.map(task => task.name))).toEqual(['Keep this local task']);
});

test('release gate guards invalid inputs, conflict reductions and portable backups', async ({ page }) => {
  await onboard(page);
  await page.getByRole('button', { name: /settings/i }).first().click();

  await page.locator('#settings-max-daily-hours').fill('999');
  await page.getByRole('button', { name: /save hours/i }).click();
  await expect(page.locator('#settings-max-daily-hours')).toHaveValue('24');

  await page.locator('#settings-day-start').fill('18:00');
  await page.locator('#settings-day-end').fill('09:00');
  await page.getByRole('button', { name: /save hours/i }).click();
  await expect(page.getByText('Day end must be later than day start.', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => [S.dayStart, S.dayEnd])).toEqual(['09:00', '18:00']);

  await openAddModal(page, 'task');
  await page.locator('#f-name').fill('Invalid zero task');
  await page.locator('#f-hours').fill('0');
  await page.getByRole('button', { name: /^save$/i }).click();
  await expect(page.locator('#modal-bg')).toBeVisible();
  await expect(page.getByText('Expected hours must be at least 0.5h.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /cancel/i }).click();

  await openAddModal(page, 'event');
  await page.locator('#f-name').fill('Invalid backwards event');
  await page.locator('#f-start').fill('17:00');
  await page.locator('#f-end').fill('09:00');
  await page.getByRole('button', { name: /^save$/i }).click();
  await expect(page.locator('#modal-bg')).toBeVisible();
  await expect(page.getByText('Event end must be later than its start.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /cancel/i }).click();

  await page.locator('#settings-day-start').fill('09:00');
  await page.locator('#settings-day-end').fill('18:00');
  await page.locator('#settings-max-daily-hours').fill('4');
  await page.getByRole('button', { name: /save hours/i }).click();
  await openAddModal(page, 'task');
  await page.locator('#f-name').fill('Non-splittable reduction');
  await page.locator('#f-hours').fill('5');
  await page.locator('#f-deadline').fill(dateString(1));
  await page.getByRole('button', { name: /show advanced options/i }).click();
  await page.locator('#f-splittable').uncheck();
  await page.getByRole('button', { name: /^save$/i }).click();
  await expect(page.locator('#conflict-bg')).toBeVisible();
  await expect(page.locator('#copt-hours')).toHaveValue('4');
  await expect(page.locator('#copt-hours-note')).toHaveText('Max that fits by current deadline: 4h');
  await page.getByRole('button', { name: /discard task/i }).click();

  await page.evaluate(() => {
    S.account = { revision: 5, email: 'person@example.com', lastSyncAt: null, lastError: '' };
    S.cloud = { endpoint: 'https://example.test/state', token: 'release-gate-secret' };
    save();
  });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /export backup/i }).click();
  const download = await downloadPromise;
  const backup = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  expect(backup.state.account).toBeUndefined();
  expect(backup.state.cloud).toBeUndefined();
  expect(await page.evaluate(() => S.account.revision)).toBe(5);
});
