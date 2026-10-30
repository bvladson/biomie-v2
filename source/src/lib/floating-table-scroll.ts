/**
 * Client-only controller for floating horizontal table scrollbars.
 * Creation is explicit after React hydration. Existing tables and their parents
 * are never moved or replaced: React keeps ownership of its rendered tree.
 */
export interface FloatingTableScrollController {
  init(): void;
  refresh(): void;
  destroy(): void;
}

interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface ClientBounds extends Bounds {
  sx: number;
  sy: number;
}

interface Candidate {
  tables: HTMLTableElement[];
  explicit: boolean;
}

interface ScrollRecord extends Candidate {
  owner: HTMLElement;
  outer: HTMLDivElement;
  viewport: HTMLDivElement;
  content: HTMLDivElement;
  id: string;
  previousId: string | null;
  previousMarker: string | null;
  addedTabindex: boolean;
  layer: HTMLDivElement | null;
  sourceMax: number;
  barTarget: number | null;
  visible: boolean;
  rtl: boolean;
}

interface LayoutPlan {
  record: ScrollRecord;
  rect: Bounds;
  left: number;
  top: number;
  width: number;
  label: string;
}

export function createFloatingTableScroll(): FloatingTableScrollController {
  const browser = window;
  const dom = document;
  const attribute = "data-biomie-floating-scroll";
  const layerClass = "biomie-floating-scroll-layer";
  const scopeSelector = 'dialog,[role="dialog"],[aria-modal="true"]';
  const excludedSelector = 'nav,menu,[role="tablist"],.carousel,.swiper';
  const menuSelector =
    '[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper],[data-biomie-floating-scroll-obstacle]';
  const transitionEvents = [
    "transitionrun",
    "transitionend",
    "transitioncancel",
    "animationstart",
    "animationend",
    "animationcancel",
  ];
  const records = new Map<HTMLElement, ScrollRecord>();
  const bars = new Map<HTMLElement, ScrollRecord>();
  const layers = new Map<HTMLElement, HTMLDivElement>();
  let observed = new Set<HTMLElement>();
  const transitions = new Map<HTMLElement, number>();
  let resizeObserver: ResizeObserver | null = null;
  let mutationObserver: MutationObserver | null = null;
  let active = false;
  let frame = 0;
  let scanNeeded = true;
  let sequence = 0;
  let rtlType: "default" | "negative" | "reverse" | null = null;
  const gap = 4;

  function own(node: Node | null): boolean {
    return node instanceof Element && Boolean(node.closest(`.${layerClass}`));
  }

  function allowed(element: Element): boolean {
    if (element.closest(`[${attribute}="off"]`)) return false;
    return Boolean(element.closest(`[${attribute}="on"]`)) || !element.closest(excludedSelector);
  }

  function scrolling(style: CSSStyleDeclaration): boolean {
    return /^(auto|scroll|overlay)$/.test(style.overflowX);
  }

  function usableTableViewport(element: HTMLElement): boolean {
    if (element.tagName !== "TABLE" || !element.parentElement) return true;
    const parent = element.parentElement;
    if (!parent.clientWidth) return true;
    const box = clientRect(parent);
    const style = browser.getComputedStyle(parent);
    const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    return element.getBoundingClientRect().width <= box.right - box.left - padding * box.sx + 1;
  }

  function queue(scan = false): void {
    if (!active) return;
    scanNeeded ||= scan;
    if (!frame) frame = browser.requestAnimationFrame(render);
  }

  function putStyle(element: HTMLElement, name: "left" | "top" | "width", value: string): void {
    if (element.style[name] !== value) element.style[name] = value;
  }

  function layerFor(scope: HTMLElement): HTMLDivElement {
    const existing = layers.get(scope);
    if (existing?.isConnected) return existing;
    const layer = dom.createElement("div");
    layer.className = layerClass;
    layer.setAttribute("data-biomie-floating-scroll-layer", scope === dom.body ? "page" : "panel");
    scope.appendChild(layer);
    layers.set(scope, layer);
    return layer;
  }

  function create(owner: HTMLElement): ScrollRecord {
    const previousId = owner.getAttribute("id");
    let id = previousId;
    if (!id) {
      do {
        id = `biomie-floating-scroll-source-${++sequence}`;
      } while (dom.getElementById(id));
      owner.id = id;
    }
    const previousMarker = owner.getAttribute("data-biomie-floating-scroll-source");
    owner.setAttribute("data-biomie-floating-scroll-source", id);
    const outer = dom.createElement("div");
    outer.className = "biomie-floating-scroll";
    outer.setAttribute("data-biomie-floating-scroll-for", id);
    outer.hidden = true;
    const viewport = dom.createElement("div");
    viewport.className = "biomie-floating-scroll__viewport";
    viewport.tabIndex = 0;
    viewport.setAttribute("role", "scrollbar");
    viewport.setAttribute("aria-orientation", "horizontal");
    viewport.setAttribute("aria-controls", id);
    viewport.setAttribute("aria-valuemin", "0");
    const content = dom.createElement("div");
    content.className = "biomie-floating-scroll__content";
    content.setAttribute("aria-hidden", "true");
    viewport.appendChild(content);
    outer.appendChild(viewport);
    const record: ScrollRecord = {
      owner,
      outer,
      viewport,
      content,
      id,
      previousId,
      previousMarker,
      addedTabindex: false,
      tables: [],
      explicit: false,
      layer: null,
      sourceMax: 0,
      barTarget: null,
      visible: false,
      rtl: false,
    };
    records.set(owner, record);
    bars.set(viewport, record);
    return record;
  }

  function restore(record: ScrollRecord): void {
    if (record.outer.contains(dom.activeElement)) record.viewport.blur();
    record.outer.remove();
    bars.delete(record.viewport);
    if (record.owner.getAttribute("data-biomie-floating-scroll-source") === record.id) {
      if (record.previousMarker === null)
        record.owner.removeAttribute("data-biomie-floating-scroll-source");
      else record.owner.setAttribute("data-biomie-floating-scroll-source", record.previousMarker);
    }
    if (!record.previousId && record.owner.id === record.id) record.owner.removeAttribute("id");
    if (record.addedTabindex && record.owner.getAttribute("tabindex") === "0")
      record.owner.removeAttribute("tabindex");
  }

  function scan(): void {
    scanNeeded = false;
    const candidates = new Map<HTMLElement, Candidate>();
    const targets = new Set<HTMLElement>();
    function add(owner: HTMLElement, table: HTMLTableElement | null, explicit: boolean): void {
      if (!allowed(owner)) return;
      let entry = candidates.get(owner);
      if (!entry) {
        entry = { tables: [], explicit: false };
        candidates.set(owner, entry);
      }
      if (table && !entry.tables.includes(table)) entry.tables.push(table);
      entry.explicit ||= explicit;
    }
    dom.querySelectorAll("table").forEach((table) => {
      if (
        own(table) ||
        !allowed(table) ||
        /^(presentation|none)$/.test(table.getAttribute("role") || "")
      )
        return;
      targets.add(table);
      for (
        let element: HTMLElement | null = table;
        element && element !== dom.body && element !== dom.documentElement;
        element = element.parentElement
      ) {
        targets.add(element);
        if (scrolling(browser.getComputedStyle(element)) && usableTableViewport(element))
          add(element, table, false);
      }
    });
    dom.querySelectorAll<HTMLElement>(`[${attribute}="on"]`).forEach((element) => {
      if (own(element) || !allowed(element)) return;
      if (usableTableViewport(element))
        add(element, element instanceof HTMLTableElement ? element : null, true);
      for (
        let parent: HTMLElement | null = element;
        parent && parent !== dom.documentElement;
        parent = parent.parentElement
      )
        targets.add(parent);
    });
    records.forEach((record, owner) => {
      if (!candidates.has(owner) || !owner.isConnected) {
        restore(record);
        records.delete(owner);
      }
    });
    candidates.forEach((entry, owner) => {
      const record = records.get(owner) || create(owner);
      record.tables = entry.tables;
      record.explicit = entry.explicit;
      const layer = layerFor(owner.closest<HTMLElement>(scopeSelector) || dom.body);
      if (record.outer.parentElement !== layer) layer.appendChild(record.outer);
      record.layer = layer;
    });
    layers.forEach((layer, scope) => {
      if (!layer.children.length || !scope.isConnected) {
        layer.remove();
        layers.delete(scope);
      }
    });
    const observer = resizeObserver;
    if (observer) {
      observed.forEach((element) => {
        if (!targets.has(element)) observer.unobserve(element);
      });
      targets.forEach((element) => {
        if (!observed.has(element)) observer.observe(element);
      });
      observed = targets;
    }
  }

  function intersect(a: Bounds, b: Bounds, x: boolean, y: boolean): Bounds {
    if (x) {
      a.left = Math.max(a.left, b.left);
      a.right = Math.min(a.right, b.right);
    }
    if (y) {
      a.top = Math.max(a.top, b.top);
      a.bottom = Math.min(a.bottom, b.bottom);
    }
    return a;
  }

  function clientRect(element: HTMLElement): ClientBounds {
    const rect = element.getBoundingClientRect();
    const sx = element.offsetWidth ? rect.width / element.offsetWidth : 1;
    const sy = element.offsetHeight ? rect.height / element.offsetHeight : 1;
    const left = rect.left + element.clientLeft * sx;
    const top = rect.top + element.clientTop * sy;
    return {
      left,
      top,
      right: left + element.clientWidth * sx,
      bottom: top + element.clientHeight * sy,
      sx: sx || 1,
      sy: sy || 1,
    };
  }

  function viewportRect(): Bounds {
    const view = browser.visualViewport;
    const left = view?.offsetLeft || 0;
    const top = view?.offsetTop || 0;
    return {
      left,
      top,
      right: left + (view ? view.width : dom.documentElement.clientWidth),
      bottom: top + (view ? view.height : browser.innerHeight),
    };
  }

  function hidden(element: HTMLElement): boolean {
    return (
      !element.isConnected ||
      !element.getClientRects().length ||
      Boolean(element.closest('[hidden],[inert],[aria-hidden="true"]')) ||
      browser.getComputedStyle(element).visibility !== "visible"
    );
  }

  function fixedContainingBlock(style: CSSStyleDeclaration): boolean {
    return (
      [
        "transform",
        "perspective",
        "filter",
        "backdrop-filter",
        "translate",
        "rotate",
        "scale",
      ].some((name) => {
        const value = style.getPropertyValue(name);
        return Boolean(value && value !== "none");
      }) ||
      /(?:layout|paint|strict|content)/.test(style.contain || "") ||
      /(?:transform|perspective|filter|translate|rotate|scale|contain)/.test(
        style.willChange || "",
      ) ||
      style.contentVisibility === "auto"
    );
  }

  function modalTopLayer(element: Element): boolean {
    try {
      return element.matches(":modal");
    } catch {
      return false;
    }
  }

  function clipOf(owner: HTMLElement, box: Bounds): Bounds {
    const clip = intersect(viewportRect(), box, true, true);
    if (modalTopLayer(owner)) return clip;
    let outsideFixed = browser.getComputedStyle(owner).position === "fixed";
    for (
      let ancestor = owner.parentElement;
      ancestor && ancestor !== dom.body && ancestor !== dom.documentElement;
      ancestor = ancestor.parentElement
    ) {
      const style = browser.getComputedStyle(ancestor);
      // Fixed panels escape ordinary overflow ancestors until their real
      // containing block; background cards must not shorten a viewport drawer.
      if (outsideFixed && !fixedContainingBlock(style)) {
        if (style.clipPath !== "none") intersect(clip, clientRect(ancestor), true, true);
        continue;
      }
      outsideFixed = false;
      const paint =
        /(?:paint|strict|content)/.test(style.contain || "") || style.clipPath !== "none";
      const x = paint || /^(auto|scroll|overlay|hidden|clip)$/.test(style.overflowX);
      const y = paint || /^(auto|scroll|overlay|hidden|clip)$/.test(style.overflowY);
      if (x || y) intersect(clip, clientRect(ancestor), x, y);
      if (modalTopLayer(ancestor)) break;
      outsideFixed = style.position === "fixed";
    }
    return clip;
  }

  function nearestOwner(table: HTMLTableElement, owner: HTMLElement): boolean {
    for (
      let element: HTMLElement | null = table;
      element && element !== owner;
      element = element.parentElement
    ) {
      if (records.has(element) && element.scrollWidth > element.clientWidth + 1) return false;
    }
    return true;
  }

  function dataBounds(record: ScrollRecord, clip: Bounds): Bounds | null {
    if (record.explicit && !record.tables.length) return { ...clip };
    let best: Bounds | null = null;
    for (const table of record.tables) {
      if (hidden(table) || !allowed(table) || !nearestOwner(table, record.owner)) continue;
      const rect = table.getBoundingClientRect();
      const top = table.tHead
        ? Math.max(rect.top, table.tHead.getBoundingClientRect().bottom)
        : rect.top;
      const band = {
        left: clip.left,
        right: clip.right,
        top: Math.max(clip.top, top),
        bottom: Math.min(clip.bottom, rect.bottom),
      };
      if (!best || band.bottom - band.top > best.bottom - best.top) best = band;
    }
    return best;
  }

  function nativeAllowed(owner: HTMLElement, style: CSSStyleDeclaration): boolean {
    if (style.scrollbarWidth === "none") return false;
    try {
      if (!browser.CSS?.supports("selector(::-webkit-scrollbar)")) return true;
      const scrollbar = browser.getComputedStyle(owner, "::-webkit-scrollbar");
      if (scrollbar.display === "none" || scrollbar.height === "0px") return false;
    } catch {
      /* Firefox can omit WebKit pseudo-element styles. */
    }
    return true;
  }

  function visibleBlocker(record: ScrollRecord, rect: Bounds): DOMRect | null {
    if (!dom.elementsFromPoint) return null;
    const xs = [rect.left + 2, (rect.left + rect.right) / 2, rect.right - 2];
    const ys = [rect.top + 1, (rect.top + rect.bottom) / 2, rect.bottom - 1];
    for (const y of ys)
      for (const x of xs) {
        for (const element of dom.elementsFromPoint(x, y)) {
          if (own(element) || element === dom.documentElement || element === dom.body) continue;
          if (element === record.owner || element.contains(record.owner)) break;
          if (record.owner.contains(element)) {
            const menu = element.closest(menuSelector);
            if (menu && menu !== record.owner) return menu.getBoundingClientRect();
            for (
              let parent: Element | null = element;
              parent && parent !== record.owner;
              parent = parent.parentElement
            ) {
              const position = browser.getComputedStyle(parent).position;
              if (
                (position === "sticky" || position === "fixed") &&
                !/^(TD|TH|TR|TBODY|TABLE)$/.test(parent.tagName)
              )
                return parent.getBoundingClientRect();
            }
            break;
          }
          return (element.closest(menuSelector) || element).getBoundingClientRect();
        }
      }
    return null;
  }

  function avoidObstacles(record: ScrollRecord, bounds: Bounds, height: number): Bounds | null {
    let bottom = bounds.bottom - gap;
    for (let attempt = 0; attempt < 6; attempt++) {
      const rect = {
        left: bounds.left + gap,
        right: bounds.right - gap,
        top: bottom - height,
        bottom,
      };
      if (rect.right - rect.left < 64 || rect.top < bounds.top + gap) return null;
      const obstacle = visibleBlocker(record, rect);
      if (!obstacle) return rect;
      if (obstacle.top >= bottom || obstacle.bottom <= rect.top) return null;
      bottom = Math.min(bottom, obstacle.top - gap);
    }
    return null;
  }

  function nativeVisible(
    record: ScrollRecord,
    box: ClientBounds,
    clip: Bounds,
    style: CSSStyleDeclaration,
  ): boolean {
    if (!nativeAllowed(record.owner, style)) return false;
    const owner = record.owner;
    const border = parseFloat(style.borderBottomWidth) || 0;
    const rect = owner.getBoundingClientRect();
    const gutter =
      Math.max(0, owner.offsetHeight - owner.clientHeight - owner.clientTop - border) * box.sy;
    const bottom = rect.bottom - border * box.sy;
    const strip = {
      left: clip.left + gap,
      right: clip.right - gap,
      top: bottom - Math.max(gutter, 3),
      bottom,
    };
    const outside = clipOf(owner, { left: box.left, right: box.right, top: rect.top, bottom });
    if (
      strip.top < outside.top - 1 ||
      strip.bottom > outside.bottom + 1 ||
      strip.right - strip.left < 64
    )
      return false;
    return !visibleBlocker(record, strip);
  }

  function rtlMode(): "default" | "negative" | "reverse" {
    if (rtlType) return rtlType;
    const outer = dom.createElement("div");
    outer.dir = "rtl";
    outer.style.cssText =
      "position:absolute;left:-10000px;top:-10000px;width:4px;height:1px;overflow:scroll;visibility:hidden";
    const inner = dom.createElement("div");
    inner.style.width = "8px";
    outer.appendChild(inner);
    dom.body.appendChild(outer);
    if (outer.scrollLeft > 0) rtlType = "default";
    else {
      outer.scrollLeft = 1;
      rtlType = outer.scrollLeft === 0 ? "negative" : "reverse";
    }
    outer.remove();
    return rtlType;
  }

  function sourceLeft(record: ScrollRecord): number {
    const value = record.owner.scrollLeft;
    if (!record.rtl) return Math.max(0, Math.min(record.sourceMax, value));
    const mode = rtlMode();
    return Math.max(
      0,
      Math.min(
        record.sourceMax,
        mode === "negative"
          ? record.sourceMax + value
          : mode === "reverse"
            ? record.sourceMax - value
            : value,
      ),
    );
  }

  function setSourceLeft(record: ScrollRecord, value: number): void {
    value = Math.max(0, Math.min(record.sourceMax, value));
    let next = value;
    if (record.rtl) {
      const mode = rtlMode();
      next =
        mode === "negative"
          ? value - record.sourceMax
          : mode === "reverse"
            ? record.sourceMax - value
            : value;
    }
    if (Math.abs(record.owner.scrollLeft - next) > 0.5) record.owner.scrollLeft = next;
  }

  function syncBar(record: ScrollRecord): void {
    const max = record.viewport.scrollWidth - record.viewport.clientWidth;
    const value = sourceLeft(record);
    const next = record.sourceMax ? (value / record.sourceMax) * max : 0;
    if (Math.abs(record.viewport.scrollLeft - next) > 0.5) {
      record.barTarget = next;
      record.viewport.scrollLeft = next;
    }
    record.viewport.setAttribute("aria-valuemax", String(Math.round(record.sourceMax)));
    record.viewport.setAttribute("aria-valuenow", String(Math.round(value)));
  }

  function hide(record: ScrollRecord): void {
    if (record.outer.contains(dom.activeElement)) {
      if (!hidden(record.owner)) {
        if (!record.owner.hasAttribute("tabindex")) {
          record.owner.tabIndex = 0;
          record.addedTabindex = true;
        }
        record.owner.focus({ preventScroll: true });
      } else record.viewport.blur();
    }
    if (!record.outer.hidden) record.outer.hidden = true;
    record.visible = false;
  }

  function measure(record: ScrollRecord): LayoutPlan | null {
    const owner = record.owner;
    if (hidden(owner) || !allowed(owner) || !record.layer) return null;
    const style = browser.getComputedStyle(owner);
    record.rtl = style.direction === "rtl";
    record.sourceMax = Math.max(0, owner.scrollWidth - owner.clientWidth);
    if (record.sourceMax <= 1 || owner.clientWidth < 1) return null;
    const box = clientRect(owner);
    const clip = clipOf(owner, box);
    if (clip.right - clip.left < 72 || clip.bottom <= clip.top) return null;
    const bounds = dataBounds(record, clip);
    if (!bounds || bounds.bottom <= bounds.top || nativeVisible(record, box, clip, style))
      return null;
    const layer = record.layer;
    const layerRect = layer.getBoundingClientRect();
    const sx = layer.offsetWidth ? layerRect.width / layer.offsetWidth : 1;
    const sy = layer.offsetHeight ? layerRect.height / layer.offsetHeight : 1;
    if (!sx || !sy) return null;
    const height =
      parseFloat(
        browser.getComputedStyle(record.outer).getPropertyValue("--biomie-floating-scroll-height"),
      ) || 24;
    const rect = avoidObstacles(record, bounds, height * sy);
    if (!rect) return null;
    const table = record.tables[0];
    const label =
      owner.getAttribute("data-biomie-floating-scroll-label") ||
      table?.getAttribute("data-biomie-floating-scroll-label") ||
      table?.getAttribute("aria-label") ||
      table?.caption?.textContent?.trim() ||
      "Rolagem horizontal da tabela";
    return {
      record,
      rect,
      left: (rect.left - layerRect.left) / sx,
      top: (rect.top - layerRect.top) / sy,
      width: (rect.right - rect.left) / sx,
      label,
    };
  }

  function render(): void {
    frame = 0;
    if (!active) return;
    if (scanNeeded) scan();
    const plans: LayoutPlan[] = [];
    records.forEach((record) => {
      const plan = measure(record);
      if (plan) plans.push(plan);
      else hide(record);
    });
    for (const plan of plans) {
      const covered = plans.some(
        (other) =>
          other !== plan &&
          plan.record.owner.contains(other.record.owner) &&
          plan.rect.left < other.rect.right &&
          plan.rect.right > other.rect.left &&
          plan.rect.top < other.rect.bottom &&
          plan.rect.bottom > other.rect.top,
      );
      if (covered) {
        hide(plan.record);
        continue;
      }
      const record = plan.record;
      putStyle(record.outer, "left", `${plan.left}px`);
      putStyle(record.outer, "top", `${plan.top}px`);
      putStyle(record.outer, "width", `${plan.width}px`);
      record.viewport.setAttribute("aria-label", plan.label);
      record.outer.hidden = false;
      record.visible = true;
    }
    // Proportional ranges keep both edges reachable if clipping narrows the bar.
    for (const { record } of plans) {
      if (!record.visible) continue;
      const width = record.viewport.clientWidth;
      putStyle(
        record.content,
        "width",
        `${Math.max(width + 1, (width * record.owner.scrollWidth) / record.owner.clientWidth)}px`,
      );
      syncBar(record);
    }
    let moving = false;
    transitions.forEach((until, element) => {
      if (!element.isConnected || until < Date.now()) transitions.delete(element);
      else moving = true;
    });
    if (moving) queue();
  }

  function onScroll(event: Event): void {
    const record = event.target instanceof HTMLElement ? bars.get(event.target) : undefined;
    if (record?.visible) {
      const position = record.viewport.scrollLeft;
      if (record.barTarget !== null && Math.abs(position - record.barTarget) <= 1)
        record.barTarget = null;
      else {
        record.barTarget = null;
        const max = record.viewport.scrollWidth - record.viewport.clientWidth;
        if (max > 0) setSourceLeft(record, (position / max) * record.sourceMax);
      }
    }
    queue();
  }

  function onKey(event: KeyboardEvent): void {
    const record = event.target instanceof HTMLElement ? bars.get(event.target) : undefined;
    if (!record?.visible || event.altKey || event.ctrlKey || event.metaKey) return;
    let value = sourceLeft(record);
    if (event.key === "ArrowLeft") value -= 40;
    else if (event.key === "ArrowRight") value += 40;
    else if (event.key === "Home") value = 0;
    else if (event.key === "End") value = record.sourceMax;
    else if (event.key === "PageDown") value += record.owner.clientWidth * 0.9;
    else if (event.key === "PageUp") value -= record.owner.clientWidth * 0.9;
    else return;
    event.preventDefault();
    setSourceLeft(record, value);
    syncBar(record);
    queue();
  }

  function onMutation(mutations: MutationRecord[]): void {
    const changed = mutations.some((mutation) => {
      if (own(mutation.target)) return false;
      if (mutation.type !== "childList") return true;
      return (
        Array.from(mutation.addedNodes).some((node) => !own(node)) ||
        Array.from(mutation.removedNodes).some((node) => !own(node))
      );
    });
    if (changed) queue(true);
  }

  function onResize(): void {
    queue(true);
  }
  function onLayout(): void {
    queue();
  }
  function onTransition(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLElement) || own(target)) return;
    const relevant =
      target.matches(scopeSelector) ||
      Array.from(records.values()).some((record) => target.contains(record.owner));
    if (!relevant) return;
    if (event.type === "transitionrun" || event.type === "animationstart")
      transitions.set(target, Date.now() + 1500);
    else transitions.delete(target);
    queue();
  }

  function init(): void {
    if (active) {
      queue(true);
      return;
    }
    if (!dom.body) {
      dom.addEventListener("DOMContentLoaded", init, { once: true });
      return;
    }
    active = true;
    if (browser.ResizeObserver) resizeObserver = new browser.ResizeObserver(onResize);
    if (browser.MutationObserver) {
      mutationObserver = new browser.MutationObserver(onMutation);
      mutationObserver.observe(dom.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: [
          "style",
          "class",
          "hidden",
          "open",
          "inert",
          "aria-hidden",
          attribute,
          "data-biomie-floating-scroll-label",
          "data-biomie-floating-scroll-obstacle",
        ],
      });
    }
    dom.addEventListener("scroll", onScroll, { capture: true, passive: true });
    dom.addEventListener("keydown", onKey);
    dom.addEventListener("focusin", onLayout);
    dom.addEventListener("focusout", onLayout);
    transitionEvents.forEach((event) => dom.addEventListener(event, onTransition, true));
    browser.addEventListener("resize", onResize, { passive: true });
    browser.addEventListener("scroll", onLayout, { passive: true });
    browser.visualViewport?.addEventListener("resize", onResize, { passive: true });
    browser.visualViewport?.addEventListener("scroll", onLayout, { passive: true });
    dom.fonts?.addEventListener("loadingdone", onResize);
    queue(true);
  }

  function destroy(): void {
    dom.removeEventListener("DOMContentLoaded", init);
    active = false;
    if (frame) browser.cancelAnimationFrame(frame);
    frame = 0;
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    resizeObserver = null;
    mutationObserver = null;
    dom.removeEventListener("scroll", onScroll, true);
    dom.removeEventListener("keydown", onKey);
    dom.removeEventListener("focusin", onLayout);
    dom.removeEventListener("focusout", onLayout);
    transitionEvents.forEach((event) => dom.removeEventListener(event, onTransition, true));
    browser.removeEventListener("resize", onResize);
    browser.removeEventListener("scroll", onLayout);
    browser.visualViewport?.removeEventListener("resize", onResize);
    browser.visualViewport?.removeEventListener("scroll", onLayout);
    dom.fonts?.removeEventListener("loadingdone", onResize);
    records.forEach(restore);
    layers.forEach((layer) => layer.remove());
    records.clear();
    bars.clear();
    layers.clear();
    observed.clear();
    transitions.clear();
    scanNeeded = true;
  }

  return { init, refresh: () => queue(true), destroy };
}
