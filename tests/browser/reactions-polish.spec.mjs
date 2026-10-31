import { expect } from "@playwright/test";
import { test } from "./source-fixture.mjs";

test("grouped reaction counts fit and preview in both themes and text sizes", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/emoji.html?reactions&grouped=8&narrow");
  const individual = page.getByRole("button", { name: "👍: 8 people" });
  await individual.focus();
  await page.keyboard.press("Enter");
  const group = page.getByRole("button", { name: "👍: 9 people" });
  await expect(group).toBeFocused();
  await expect(
    page.locator("[data-message-id]").first().getByTestId("reaction-row"),
  ).toHaveText("👍9");
  for (const theme of ["light", "dark"]) {
    for (const scale of [1, 2]) {
      await page.evaluate(
        ({ theme, scale }) => {
          document.documentElement.dataset.colorMode = theme;
          document.documentElement.style.setProperty(
            "--buzz-text-scale",
            String(scale),
          );
        },
        { theme, scale },
      );
      await expect(group).toBeVisible();
      await expect(group).toContainText("9");
      await expect
        .poll(() =>
          group.evaluate((button) => {
            const control = button.getBoundingClientRect();
            const glyph = button
              .querySelector("[data-reaction-glyph]")
              .getBoundingClientRect();
            return (
              glyph.left >= control.left &&
              glyph.right <= control.right &&
              glyph.top >= control.top &&
              glyph.bottom <= control.bottom
            );
          }),
        )
        .toBe(true);
    }
  }
  // Activation dismisses the preview; keyboard re-entry opens it again.
  await group.press("Tab");
  await group.focus();
  const preview = page.getByRole("dialog", { name: "👍 reactions" });
  await expect(preview).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("grouped-reactions.png"),
  });
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
});

// Browser-only: available popup height and real line clamping at enlarged text.
test("large reaction previews keep the remainder count visible without scrolling", async ({
  page,
}) => {
  for (const { count, width, scale } of [
    { count: 150, width: 1440, scale: 1 },
    { count: 40, width: 520, scale: 2 },
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.goto(
      `/tests/fixtures/emoji.html?reactions&grouped=${count}&long-names`,
    );
    await page.evaluate(
      (scale) =>
        document.documentElement.style.setProperty(
          "--buzz-text-scale",
          String(scale),
        ),
      scale,
    );
    const group = page.getByRole("button", { name: `👍: ${count} people` });
    await group.focus();
    const preview = page.getByRole("dialog", { name: "👍 reactions" });
    const remainder = preview.getByText(`and ${count - 3} others`, {
      exact: true,
    });
    await expect(remainder).toBeVisible();
    await expect(preview).toContainText("Teammate 3");
    await expect(preview).not.toContainText("Teammate 4 ");
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (theme) => (document.documentElement.dataset.colorMode = theme),
        theme,
      );
      await expect
        .poll(() =>
          preview.evaluate((card) => card.scrollHeight <= card.clientHeight),
        )
        .toBe(true);
      const card = await preview.boundingBox();
      const summary = await remainder.boundingBox();
      expect(summary.y + summary.height).toBeLessThanOrEqual(
        card.y + card.height,
      );
    }
  }
});

// Browser-only: a slow pointer crosses the real gap between the pill and its
// preview, and only real scrolling decides which list rows load names.
test("a slow pointer opens the full reaction list, which loads names as rows scroll in", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/emoji.html?reactions&grouped=40");
  const group = page.getByRole("button", { name: "👍: 40 people" });
  const preview = page.getByRole("dialog", { name: "👍 reactions" });
  const pill = await group.boundingBox();
  const start = { x: pill.x + pill.width / 2, y: pill.y + pill.height / 2 };
  await page.mouse.move(start.x, start.y);
  await expect(preview).toBeVisible();
  const link = await preview
    .getByRole("button", { name: "and 37 others" })
    .boundingBox();
  const end = { x: link.x + link.width / 2, y: link.y + link.height / 2 };
  // One pixel per step: a faster pointer can skip the gap.
  await page.mouse.move(end.x, end.y, {
    steps: Math.ceil(Math.hypot(end.x - start.x, end.y - start.y)),
  });
  await expect(preview).toBeVisible();
  await page.mouse.down();
  await page.mouse.up();
  const list = page.getByRole("menu", { name: "Everyone who reacted with 👍" });
  await expect(list).toBeVisible();
  const rows = list.getByRole("menuitem");
  await expect(rows).toHaveCount(40);
  // The fixture host opens no profiles; its rows are not unavailable.
  await expect(rows.first()).not.toHaveAttribute("data-disabled");
  const ids = await rows.evaluateAll((items) =>
    items.map((item) => item.dataset.reactor),
  );
  const requested = () =>
    page.evaluate(() => window.emojiFixture.report.profileReads.flat());
  // The preview loads three names; the list loads the rows in view.
  await expect
    .poll(async () => (await requested()).includes(ids[5]))
    .toBe(true);
  expect(await requested()).not.toContain(ids.at(-1));
  await rows.last().scrollIntoViewIfNeeded();
  await expect
    .poll(async () => (await requested()).includes(ids.at(-1)))
    .toBe(true);
});

// Browser-only: actual rem geometry and the line-height clipping boundary need
// the production stylesheet and layout engine, not a DOM emulator.
test("reaction emojis and hit areas grow together without clipping", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/emoji.html?reactions&wrap");
  const message = page
    .locator("[data-message-id]")
    .filter({ hasText: "Historic" });
  const pill = message.locator('button[data-reaction="👍"]');
  const glyph = pill.locator("[data-reaction-glyph] > span");
  await expect(glyph).toBeVisible();
  const capsule = message.getByTestId("reaction-row");
  await expect(capsule).toHaveCSS("column-gap", "0px");
  await expect(capsule).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(pill.locator("..")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  const addReaction = capsule.getByRole("button", {
    name: "Add reaction",
    exact: true,
  });
  await expect(addReaction.locator("..")).toHaveCSS(
    "background-color",
    await pill
      .locator("..")
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  );
  await expect
    .poll(() =>
      message.evaluate((row) => {
        const bubble = row.querySelector("[data-message-action-anchor]");
        const reactions = row.querySelector('[data-testid="reaction-row"]');
        return {
          nested: bubble.contains(reactions),
          bottomInset:
            bubble.getBoundingClientRect().bottom -
            reactions.getBoundingClientRect().bottom,
        };
      }),
    )
    .toEqual({ nested: true, bottomInset: 8 });
  for (const [theme, scale] of [
    ["light", 1],
    ["light", 1.5],
    ["dark", 2],
    ["dark", 1],
  ]) {
    await page.evaluate(
      ({ theme, scale }) => {
        document.documentElement.dataset.colorMode = theme;
        document.documentElement.style.setProperty(
          "--buzz-text-scale",
          String(scale),
        );
      },
      { theme, scale },
    );
    await expect
      .poll(async () => (await pill.boundingBox()).width)
      .toBeGreaterThanOrEqual(32 * scale);
    await expect(pill).toHaveCSS("height", `${32 * scale}px`);
    await expect(addReaction).toHaveCSS("height", `${32 * scale}px`);
    await expect(glyph).toHaveCSS("font-size", `${12 * scale}px`);
    await expect(glyph).toHaveCSS("height", `${16 * scale}px`);
    const bounds = await pill.evaluate((el) => {
      const button = el.getBoundingClientRect();
      const emoji = el
        .querySelector("[data-reaction-glyph] > span")
        .getBoundingClientRect();
      return {
        contained:
          emoji.top >= button.top &&
          emoji.bottom <= button.bottom &&
          emoji.left >= button.left &&
          emoji.right <= button.right,
      };
    });
    expect(bounds.contained).toBe(true);
  }
  const hitArea = await pill.boundingBox();
  // Typing leaves keyboard modality active until a click. Pointer hover must
  // still animate without requiring that extra click.
  await page.keyboard.press("a");
  await expect(page.locator("html")).toHaveAttribute("data-keyboard-input", "");
  await pill.hover();
  await expect(pill).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect
    .poll(() =>
      pill.locator("[data-reaction-glyph]").evaluate((el) => {
        const matrix = new DOMMatrix(getComputedStyle(el).transform);
        const angle = (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
        return {
          scale: Number(Math.hypot(matrix.a, matrix.b).toFixed(2)),
          inRange: angle >= -10 && angle <= 10,
        };
      }),
    )
    .toEqual({ scale: 1.1, inRange: true });
  expect(await pill.boundingBox()).toEqual(hitArea);
  await page.mouse.move(0, 0);
  await expect(pill.locator("[data-reaction-glyph]")).toHaveCSS(
    "transform",
    "none",
  );
  await pill.focus();
  await expect(pill.locator("[data-reaction-glyph]")).toHaveCSS(
    "transform",
    "none",
  );
});

test("reaction bubbles wrap, preview, toggle, and add from the inline control", async ({
  page,
}, testInfo) => {
  await page.route("**/emoji-media/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M2 4Q4 1 8 2q6-1 6 5 0 7-6 7Q1 14 2 8Z" fill="#82d93e"/><circle cx="6" cy="6" r="1"/><circle cx="11" cy="6" r="1"/><path d="M5 10q3 3 6 0" fill="none" stroke="#172710" stroke-width="1"/></svg>',
    }),
  );
  await page.goto("/tests/fixtures/emoji.html?reactions&wrap&narrow");
  const message = page.locator("[data-message-id]").first();
  const row = message.getByTestId("reaction-row");
  const pills = row.locator("button[data-reaction]");
  await expect(pills).toHaveCount(12);
  const order = () =>
    pills.evaluateAll((items) => items.map((item) => item.dataset.reaction));
  const initialOrder = await order();
  const tops = await pills.evaluateAll((items) =>
    items.map((item) => item.getBoundingClientRect().top),
  );
  expect(new Set(tops).size).toBeGreaterThan(1);

  const custom = row.locator('button[data-reaction=":party:"]');
  await expect(custom).toHaveAccessibleName(":party:: Fixture Member");
  const native = row.locator('button[data-reaction="👍"]');
  await expect(custom.locator("img")).toHaveCSS("object-fit", "contain");
  await expect(custom.locator("img")).toHaveCSS("width", "12px");
  await expect(native.locator("[data-reaction-glyph] > span")).toHaveCSS(
    "font-size",
    "12px",
  );
  await expect(custom).toHaveCSS("height", "32px");
  const plus = row.getByRole("button", { name: "Add reaction" });
  await expect(plus).toHaveCSS("width", "32px");
  await expect(plus).toHaveCSS("height", "32px");
  await message.screenshot({ path: testInfo.outputPath("reaction-row.png") });

  await custom.hover();
  const tooltip = page.locator('.buzz-preview-card[role="tooltip"][data-open]');
  await expect(tooltip).toBeVisible({ timeout: 2500 });
  await expect(tooltip.locator("img")).toHaveCount(1);
  await expect(tooltip).toContainText(":party:");
  await expect(tooltip).toContainText("Fixture Member");
  const tipBox = await tooltip.boundingBox();
  const messageBox = await message.boundingBox();
  const x = Math.max(0, Math.min(tipBox.x, messageBox.x) - 12);
  const y = Math.max(0, Math.min(tipBox.y, messageBox.y) - 12);
  await page.screenshot({
    path: testInfo.outputPath("reaction-preview.png"),
    clip: {
      x,
      y,
      width: Math.min(
        page.viewportSize().width - x,
        Math.max(tipBox.x + tipBox.width, messageBox.x + messageBox.width) -
          x +
          12,
      ),
      height: Math.min(
        page.viewportSize().height - y,
        Math.max(tipBox.y + tipBox.height, messageBox.y + messageBox.height) -
          y +
          12,
      ),
    },
  });
  const heart = row.locator('button[data-reaction="❤️"]');
  await heart.hover();
  await expect(tooltip).toBeVisible({ timeout: 500 });
  await expect(tooltip).toContainText("heart");
  await expect(tooltip).toHaveClass(/reactionPreviewSlideRight/);
  await page.mouse.move(0, 0);

  await page.evaluate(() => window.emojiFixture.holdNextReaction(":party:"));
  try {
    await custom.click();
    await expect
      .poll(() =>
        page.evaluate(() => window.emojiFixture.report.reactionStarted),
      )
      .toBe(true);
    await expect(custom).toHaveAttribute("aria-pressed", "true");
    await expect(row.locator('button[data-reaction=":party:"]')).toHaveCount(1);
    await expect(
      row.getByRole("button", { name: ":party:: 2 people", exact: true }),
    ).toBeVisible();
    await expect(native).toHaveAttribute("aria-disabled", "true");
    await expect(custom).toHaveCSS("opacity", "1");
    await expect(custom).toHaveAttribute("aria-disabled", "true");
    await native.evaluate((button) => button.click());
    await expect
      .poll(() => page.evaluate(() => window.emojiFixture.operations()))
      .toBe(1);
  } finally {
    await page.evaluate(() => window.emojiFixture.releaseReaction());
  }
  await expect
    .poll(() =>
      page.evaluate(() => window.emojiFixture.report.publications.length),
    )
    .toBe(1);
  await expect(custom).toHaveAttribute("aria-disabled", "false");
  await expect(pills).toHaveCount(12);
  await custom.click();
  await expect(custom).toHaveAttribute("aria-pressed", "false");
  await expect(row.locator('button[data-reaction=":party:"]')).toHaveCount(1);
  expect(await order()).toEqual(initialOrder);
  await row.locator('button[data-reaction="✅"]').click();
  await expect(row.locator('button[data-reaction="✅"]')).toHaveCount(0);

  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.locator("main").evaluate((element) => {
    element.style.marginTop = "500px";
  });
  await plus.click();
  const picker = page.locator('em-emoji-picker input[type="search"]');
  await expect(picker).toBeVisible();
  const pickerBox = await page.locator('[role="dialog"]').last().boundingBox();
  const plusBox = await plus.boundingBox();
  expect(pickerBox.y + pickerBox.height).toBeLessThan(plusBox.y);
  await picker.fill("aonly");
  await page.getByRole("button", { name: ":aonly:", exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(row.locator('button[data-reaction=":aonly:"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await plus.focus();
  await plus.press("Enter");
  await expect(picker).toBeVisible();
  await picker.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(plus).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await custom.hover();
  await expect(tooltip).toBeVisible({ timeout: 2500 });
  await expect(tooltip).toHaveCSS("transition-duration", "0s");
  await expect(custom.locator("[data-reaction-glyph]")).toHaveCSS(
    "transform",
    "none",
  );
});

// Shrink-to-fit bubble sizing and wrapping require the browser layout engine.
test("short bubbles keep one reaction beside the add-reaction pill", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/emoji.html?reactions&single-reaction");
  const message = page.locator("[data-message-id]").first();
  const reaction = message.locator('button[data-reaction="👍"]');
  const add = message.getByTestId("inline-add-reaction").getByRole("button");
  for (const [theme, width, scale] of [
    ["light", 800, 1],
    ["dark", 390, 2],
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.evaluate(
      ({ theme, scale }) => {
        document.documentElement.dataset.colorMode = theme;
        document.documentElement.style.setProperty(
          "--buzz-text-scale",
          String(scale),
        );
      },
      { theme, scale },
    );
    await expect
      .poll(async () => {
        const pill = await reaction.boundingBox();
        const plus = await add.boundingBox();
        const bubble = await message
          .locator("[data-message-action-anchor]")
          .boundingBox();
        return {
          sameLine: pill.y === plus.y,
          contained: plus.x + plus.width <= bubble.x + bubble.width,
        };
      })
      .toEqual({ sameLine: true, contained: true });
    await reaction.click();
    await expect(message.locator('button[data-reaction="👍"]')).toHaveCount(1);
    await expect(reaction).toHaveAccessibleName("👍: 2 people");
    await expect
      .poll(async () => {
        const boxes = await message
          .locator('button[data-reaction="👍"]')
          .evaluateAll((buttons) =>
            buttons.map((button) => button.getBoundingClientRect().y),
          );
        const plus = await add.boundingBox();
        return boxes.every((y) => y === plus.y);
      })
      .toBe(true);
    await expect(reaction).toHaveAttribute("aria-disabled", "false");
    await reaction.click();
    await expect(message.locator('button[data-reaction="👍"]')).toHaveCount(1);
  }
});

// Actual popup geometry must follow each emoji bubble.
test("reaction previews center above each emoji bubble", async ({ page }) => {
  // Keep failed-image retries from changing the hovered message's layout.
  await page.route("**/emoji-media/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7" fill="purple"/></svg>',
    }),
  );
  await page.goto("/tests/fixtures/emoji.html?reactions&wrap&repeated");
  const row = page.locator("[data-message-id]").first();
  await expect(
    row.locator('button[data-reaction=":party:"] img'),
  ).toHaveJSProperty("naturalWidth", 16);
  const preview = page.locator('.buzz-preview-card[role="tooltip"][data-open]');
  for (const [theme, width, scale] of [
    ["light", 1440, 1],
    ["dark", 900, 2],
  ]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.evaluate(
      ({ theme, scale }) => {
        document.documentElement.dataset.colorMode = theme;
        document.documentElement.style.setProperty(
          "--buzz-text-scale",
          String(scale),
        );
      },
      { theme, scale },
    );
    for (const content of [":party:", "😂"]) {
      const chip = row.locator(`button[data-reaction="${content}"]`);
      const glyph = chip.locator("[data-reaction-glyph]");
      await chip.hover();
      await expect(preview).toBeVisible();
      await expect
        .poll(async () => {
          const anchor = await glyph.boundingBox();
          const popup = await preview.boundingBox();
          return Math.abs(
            popup.x + popup.width / 2 - (anchor.x + anchor.width / 2),
          );
        })
        .toBeLessThan(1);
      const anchor = await glyph.boundingBox();
      const popup = await preview.boundingBox();
      expect(popup.y + popup.height).toBeLessThan(anchor.y);
      await page.mouse.move(0, 0);
      await expect(preview).toHaveCount(0);
    }
  }
});

test("reaction previews use the delayed first open, immediate warm switch, and reset delay", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/emoji.html?reactions&wrap");
  const row = page
    .locator("[data-message-id]")
    .first()
    .getByTestId("reaction-row");
  const custom = row.getByRole("button", {
    name: ":party:: Fixture Member",
    exact: true,
  });
  const heart = row.locator('button[data-reaction="❤️"]');
  const tooltip = page.locator('.buzz-preview-card[role="tooltip"][data-open]');
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:00:10Z"));
  try {
    // Previews wait for the pointer to rest 0.3s (DESIGN.md "Hover timing").
    await custom.hover();
    await expect(tooltip).toHaveCount(0);
    await page.clock.runFor(299);
    await expect(tooltip).toHaveCount(0);
    await page.clock.runFor(1);
    await expect(tooltip).toBeVisible();
    await heart.hover();
    await expect(tooltip).toContainText("heart");
    // Leaving the row keeps the preview for its close grace, so a slow
    // pointer can cross to it.
    await page.mouse.move(0, 0);
    await page.clock.runFor(74);
    await expect(tooltip).toBeVisible();
    await page.clock.runFor(1);
    await expect(tooltip).toHaveCount(0);
    await page.clock.runFor(151);
    await custom.hover();
    await page.clock.runFor(299);
    await expect(tooltip).toHaveCount(0);
    await page.clock.runFor(1);
    await expect(tooltip).toBeVisible();
  } finally {
    await page.clock.resume();
  }
});

// Browser-only: React counts the portaled list as inside the reaction row, and
// only a real engine decides whether a list unmounting under the pointer sends
// the row a leave. WebKit sends none for either close, Chromium none for Escape.
for (const close of ["choosing a reactor", "Escape"]) {
  test(`closing the full reaction list by ${close} leaves the next preview waiting for a rest`, async ({
    page,
  }) => {
    // Without exit motion the list unmounts before the pointer is hit-tested
    // again, so no boundary event can reach the row first.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/tests/fixtures/emoji.html?reactions&grouped=40&wrap");
    const row = page
      .locator("[data-message-id]")
      .first()
      .getByTestId("reaction-row");
    const preview = page.getByRole("dialog", { name: "👍 reactions" });
    const list = page.getByRole("menu", {
      name: "Everyone who reacted with 👍",
    });
    const tooltip = page.locator(
      '.buzz-preview-card[role="tooltip"][data-open]',
    );
    await row.getByRole("button", { name: "👍: 41 people" }).hover();
    await preview.getByRole("button", { name: "and 38 others" }).click();
    await expect(list.getByRole("menuitem")).toHaveCount(41);
    if (close === "Escape") {
      // Off the list and away from where the preview returns.
      await page.mouse.move(1390, 890);
      await page.keyboard.press("Escape");
      await expect(list).toHaveCount(0);
      // Escape closes one layer: the preview returns with focus on the pill.
      await expect(preview).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(preview).toHaveCount(0);
    } else {
      await list.getByRole("menuitem").nth(1).click();
      await expect(list).toHaveCount(0);
    }
    await page.mouse.move(1300, 800);
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-01-01T00:00:10Z"));
    try {
      await row.locator('button[data-reaction="❤️"]').hover();
      await page.clock.runFor(299);
      await expect(tooltip).toHaveCount(0);
      await page.clock.runFor(1);
      await expect(tooltip).toContainText("heart");
    } finally {
      await page.clock.resume();
    }
  });
}

test("long native reactions and unavailable shortcode artwork stay inside the hit area", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/emoji.html?reactions&long&narrow");
  const row = page
    .locator("[data-message-id]")
    .first()
    .getByTestId("reaction-row");
  for (const content of ["f".repeat(64), `:${"a".repeat(64)}:`]) {
    const pill = row.locator(`button[data-reaction="${content}"]`);
    await expect(pill).toHaveCount(1);
    await expect(pill).toHaveAttribute(
      "aria-label",
      `${content}: Fixture Member`,
    );
    const bounds = await pill.evaluate((button) => {
      const glyph = button.querySelector("[data-reaction-glyph] > span");
      const chip = button.getBoundingClientRect();
      return {
        glyphWidth: glyph.getBoundingClientRect().width,
        glyphLeft: glyph.getBoundingClientRect().left,
        glyphRight: glyph.getBoundingClientRect().right,
        chipLeft: chip.left,
        chipRight: chip.right,
        truncated: glyph.scrollWidth > glyph.clientWidth,
      };
    });
    expect(bounds.glyphWidth).toBeLessThanOrEqual(32);
    expect(bounds.truncated).toBe(true);
    expect(bounds.glyphLeft).toBeGreaterThanOrEqual(bounds.chipLeft);
    expect(bounds.glyphRight).toBeLessThanOrEqual(bounds.chipRight);
  }
});

// Browser-only: fractional-pixel SVG rasterization during neighboring hover
// animations cannot be detected by DOM geometry assertions alone.
test.describe("reaction control rendering", () => {
  test.use({ deviceScaleFactor: 2 });

  test("add-reaction icon stays still while neighboring emojis animate", async ({
    page,
  }) => {
    await page.goto("/tests/fixtures/emoji.html?reactions&wrap");
    const message = page
      .locator("[data-message-id]")
      .filter({ hasText: "Historic" })
      .locator("[data-layout]");
    const row = message.getByTestId("reaction-row");
    const plus = row.getByRole("button", { name: "Add reaction" });
    const emoji = row.locator('button[data-reaction="👍"]');
    await expect(plus).toBeVisible();
    // Fractional placement exposes repaint shifts that integer-aligned rows hide.
    await row.evaluate((el) => {
      el.style.translate = "0 0.25px";
    });
    // Stay inside the reaction area so the message hover highlight is absent
    // before, during, and after neighboring emoji motion.
    const rest = { x: 2, y: (await row.boundingBox()).height / 2 };
    await row.hover({ position: rest });
    await expect(message).not.toHaveAttribute("data-actions-revealed", "");
    await expect
      .poll(() => plus.evaluate((el) => el.matches(":hover")))
      .toBe(false);
    const bounds = await plus.boundingBox();
    const original = await plus.screenshot();
    await emoji.locator("[data-reaction-glyph]").evaluate((el) => {
      el.addEventListener(
        "transitionrun",
        () => {
          for (const animation of el.getAnimations()) {
            animation.pause();
            animation.currentTime =
              Number(animation.effect.getTiming().duration) / 2;
          }
        },
        { once: true },
      );
    });
    try {
      await emoji.hover();
      await expect
        .poll(() =>
          emoji
            .locator("[data-reaction-glyph]")
            .evaluate((el) =>
              el
                .getAnimations()
                .some((animation) => animation.playState === "paused"),
            ),
        )
        .toBe(true);
      expect(await plus.boundingBox()).toEqual(bounds);
      expect((await plus.screenshot()).equals(original)).toBe(true);
    } finally {
      await emoji.locator("[data-reaction-glyph]").evaluate((el) => {
        for (const animation of el.getAnimations()) animation.finish();
      });
    }
    await row.hover({ position: rest });
    await expect(emoji.locator("[data-reaction-glyph]")).toHaveCSS(
      "transform",
      "none",
    );
    expect(await plus.boundingBox()).toEqual(bounds);
    expect((await plus.screenshot()).equals(original)).toBe(true);
    await plus.hover();
    await expect(
      page.getByRole("tooltip", { name: "Add reaction", exact: true }),
    ).toBeVisible();
    expect(await plus.boundingBox()).toEqual(bounds);
  });
});
