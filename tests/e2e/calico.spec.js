import { expect, test } from '@playwright/test';

async function onboard(page) {
  await page.goto('/');
  await page.getByRole('button', { name: /get started/i }).click();
  await page.getByRole('button', { name: /next/i }).click();
  await page.getByRole('button', { name: /start/i }).click();
  await expect(page.locator('#app')).toBeVisible();
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
