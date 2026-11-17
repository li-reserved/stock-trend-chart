'use strict';

const limitReview = (() => {
  const byId = id => document.getElementById('limitReview' + id);
  const filter = byId('Filter');
  const caseList = byId('Cases');
  const canvas = byId('Chart');
  const context = canvas.getContext('2d');
  const ink = { text: '#a1b0c5', grid: '#28374d', accent: '#7bd9cd', up: '#ff747b', down: '#49d9ae', neutral: '#8ea4c0' };
  const money = value => value.toFixed(2);
  const lots = value => value >= 10000 ? (value / 10000).toFixed(2) + ' 万手' : value.toLocaleString('zh-CN') + ' 手';
  const percent = value => value.toFixed(2) + '%';
  let archive, loading, selected;
  let mode = 'daily', eventIndex = 0, dayIndex = 0, minuteIndex = 0;
  let chartBounds;

  function locateCase(item) {
    const address = new URL(location.href);
    address.searchParams.set('view', 'limit-review');
    address.searchParams.set('symbol', item.symbol);
    address.searchParams.set('date', item.date);
    history.replaceState(history.state, '', address);
  }

  function leave() {
    const address = new URL(location.href);
    for (const key of ['view', 'symbol', 'date']) address.searchParams.delete(key);
    history.replaceState(history.state, '', address);
  }

  function renderCases() {
    const query = filter.value.trim();
    const matches = archive.cases.filter(item => [item.name, item.symbol.slice(2), item.date].some(value => value.includes(query)));
    byId('Count').textContent = matches.length + ' / ' + archive.cases.length;
    caseList.replaceChildren();
    if (!matches.length) {
      const empty = document.createElement('p');
      empty.className = 'dash-empty';
      empty.textContent = '当前归档没有匹配的案例。';
      caseList.append(empty);
    }
    for (const item of matches) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'limit-review-case';
      button.setAttribute('aria-pressed', item === selected);
      const name = document.createElement('strong');
      name.textContent = item.name;
      const meta = document.createElement('small');
      meta.textContent = item.date + ' · ' + item.symbol.slice(2);
      const boards = document.createElement('span');
      boards.className = 'dash-pill';
      boards.textContent = item.streak + ' 板';
      button.append(name, meta, boards);
      button.onclick = () => {
        caseList.querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed', false);
        button.setAttribute('aria-pressed', true);
        showCase(item);
        if (matchMedia('(max-width: 760px)').matches) byId('Name').scrollIntoView({ block: 'start' });
      };
      caseList.append(button);
    }
  }

  function showCase(item) {
    selected = item;
    eventIndex = item.daily.findIndex(day => day.date === item.date);
    dayIndex = eventIndex;
    minuteIndex = 0;
    const day = item.daily[eventIndex];
    const previous = item.daily[eventIndex - 1];
    const average = day.amount / (day.volume * 100);
    byId('Name').textContent = item.name + ' · ' + item.symbol.slice(2);
    byId('Date').textContent = item.date + ' · ' + item.streak + ' 连板';
    byId('Source').href = item.source;
    const opening = item.firstSeal ? item.firstSeal + ' 首封' : '涨停开盘';
    byId('Event').textContent = previous.date + ' 一字板 → ' + opening + ' → 开板换手 → 收盘封板';
    const metrics = [
      ['前一日 → 当日换手率', percent(previous.turnover) + ' → ' + percent(day.turnover)],
      ['成交量 / 前一日', (day.volume / previous.volume).toFixed(2) + ' 倍'],
      ['成交均价 / 涨停价', percent(average / day.close * 100)]
    ];
    byId('Metrics').innerHTML = metrics.map(([label, value]) => '<div><dt>' + label + '</dt><dd>' + value + '</dd></div>').join('');
    locateCase(item);
    setMode('daily');
  }

  function setMode(value) {
    mode = value;
    const daily = mode === 'daily';
    byId('Daily').setAttribute('aria-pressed', daily);
    byId('Minutes').setAttribute('aria-pressed', !daily);
    byId('Step').hidden = !daily;
    renderSelection();
  }

  function minuteLabel(index) {
    const total = (index < 120 ? 9 * 60 + 31 : 13 * 60 + 1 - 120) + index;
    return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
  }

  function renderSelection() {
    let text;
    if (mode === 'daily') {
      const b = selected.daily[dayIndex];
      const tag = dayIndex === eventIndex ? ' · 换手日' : dayIndex === eventIndex - 1 ? ' · 前一日一字板' : '';
      const change = (b.change > 0 ? '+' : '') + percent(b.change);
      text = b.date + tag + '　开 ' + money(b.open) + '　高 ' + money(b.high) +
        '　低 ' + money(b.low) + '　收 ' + money(b.close) + '（' + change + '）　量 ' + lots(b.volume) + '　换手 ' + percent(b.turnover);
      byId('Prev').disabled = dayIndex === 0;
      byId('Next').disabled = dayIndex === selected.daily.length - 1;
      byId('EventDay').disabled = dayIndex === eventIndex;
    } else {
      const [price, volume] = selected.minutes[minuteIndex];
      const limit = selected.daily[eventIndex].close;
      text = selected.date + ' ' + minuteLabel(minuteIndex) + '　分钟末价 ' + money(price / 100) +
        ' 元　分钟成交量 ' + lots(volume) + '　涨停价 ' + money(limit) + ' 元';
    }
    byId('Readout').textContent = text;
    draw();
  }

  function draw() {
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!selected || !width || !height) return;
    const ratio = window.devicePixelRatio;
    const pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const ctx = context;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = '11px system-ui, sans-serif';
    const isDaily = mode === 'daily';
    const days = selected.daily;
    const minutes = selected.minutes;
    const day = days[eventIndex];
    const count = isDaily ? days.length : minutes.length;
    const low = isDaily ? Math.min(...days.map(b => b.low)) : day.low;
    const high = isDaily ? Math.max(...days.map(b => b.high)) : day.high;
    const peakVolume = Math.max(...(isDaily ? days.map(b => b.volume) : minutes.map(b => b[1])));
    const pad = Math.max((high - low) * 0.085, 0.01);
    const min = low - pad, max = high + pad;
    const left = 9, right = width - 59, top = 29;
    const priceBottom = Math.round(height * 0.69), volTop = priceBottom + 29, bottom = height - 24;
    const step = (right - left) / count;
    const x = index => left + (index + 0.5) * step;
    const y = price => priceBottom - (price - min) / (max - min) * (priceBottom - top);
    const v = volume => bottom - volume / peakVolume * (bottom - volTop);
    chartBounds = { left, step, count };
    function line(x1, y1, x2, y2, color) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    function label(text, xPos, yPos, color = ink.text, align = 'left') {
      ctx.textAlign = align;
      ctx.fillStyle = color;
      ctx.fillText(text, xPos, yPos);
    }

    label(isDaily ? '日 K · 不复权' : '分钟末价', left, 17);
    label('元', right + 7, 17);
    const volumeInLots = peakVolume < 10000;
    label(volumeInLots ? '成交量（手）' : '成交量（万手）', left, volTop - 8);
    for (let i = 0; i < 5; i++) {
      const price = low + (high - low) * i / 4;
      line(left, y(price), right, y(price), ink.grid);
      if (isDaily || i < 4) label(money(price), right + 5, y(price) + 4);
    }
    line(left, bottom, right, bottom, ink.grid);
    label(volumeInLots ? String(peakVolume) : (peakVolume / 10000).toFixed(2), right + 5, volTop + 4);

    if (isDaily) {
      ctx.fillStyle = '#7bd9cd23';
      ctx.fillRect(x(eventIndex) - step / 2, top - 5, step, bottom - top + 5);
      const w = Math.min(step * 0.62, 18);
      const first = eventIndex - selected.streak + 1;
      for (const [i, bar] of days.entries()) {
        const bullish = bar.close === bar.open ? bar.change >= 0 : bar.close >= bar.open;
        const color = bullish ? ink.up : ink.down;
        line(x(i), y(bar.high), x(i), y(bar.low), color);
        ctx.fillStyle = color;
        ctx.fillRect(x(i) - w / 2, y(Math.max(bar.open, bar.close)), w, Math.max(2, Math.abs(y(bar.open) - y(bar.close))));
        ctx.fillRect(x(i) - w / 2, v(bar.volume), w, bottom - v(bar.volume));
        if (i >= first && i <= eventIndex && (width > 560 || i === eventIndex)) {
          label(i - first + 1 + '板', x(i), y(bar.high) - 7, i === eventIndex ? ink.accent : ink.up, 'center');
        }
      }
      const spacing = Math.ceil(47 / step);
      for (let i = 0; i < days.length; i += spacing) {
        label(days[i].date.slice(5), x(i), height - 7, ink.text, 'center');
      }
    } else {
      ctx.setLineDash([4, 4]);
      line(left, y(day.close), right, y(day.close), ink.accent);
      ctx.setLineDash([]);
      label('涨停 ' + money(day.close), right - 4, y(day.close) - 6, ink.accent, 'right');
      for (const [i, [price, volume]] of minutes.entries()) {
        const previous = i ? minutes[i - 1][0] : day.open * 100;
        ctx.fillStyle = price > previous ? ink.up : price < previous ? ink.down : ink.neutral;
        ctx.fillRect(x(i) - step / 2, v(volume), Math.max(1, step * 0.83), bottom - v(volume));
      }
      ctx.strokeStyle = '#8eb5ff';
      ctx.lineWidth = 1.35;
      ctx.beginPath();
      for (const [i, [price]] of minutes.entries()) {
        if (i === 0) ctx.moveTo(x(i), y(price / 100));
        else ctx.lineTo(x(i), y(price / 100));
      }
      ctx.stroke();
      ctx.lineWidth = 1;
      const ticks = [[left, '09:30', 'left'], [left + step * 120, '11:30 / 13:00', 'center'], [right, '15:00', 'right']];
      if (width >= 480) ticks.push([left + step * 60, '10:30', 'center'], [left + step * 180, '14:00', 'center']);
      for (const [position, text, align] of ticks) label(text, position, height - 7, ink.text, align);
    }

    const cursor = isDaily ? dayIndex : minuteIndex;
    const selectedPrice = isDaily ? days[cursor].close : minutes[cursor][0] / 100;
    ctx.setLineDash([3, 3]);
    line(x(cursor), top - 5, x(cursor), bottom, '#a1b0c5b5');
    ctx.setLineDash([]);
    ctx.fillStyle = ink.accent;
    ctx.beginPath();
    ctx.arc(x(cursor), y(selectedPrice), 3, 0, 2 * Math.PI);
    ctx.fill();
  }

  function selectIndex(index) {
    if (mode === 'daily') dayIndex = Math.max(0, Math.min(selected.daily.length - 1, index));
    else minuteIndex = Math.max(0, Math.min(selected.minutes.length - 1, index));
    renderSelection();
  }

  function locatePointer(event) {
    const { left, step, count } = chartBounds;
    const x = event.offsetX - left;
    if (x >= 0 && x < step * count) {
      const index = Math.floor(x / step);
      if (index !== (mode === 'daily' ? dayIndex : minuteIndex)) selectIndex(index);
    }
  }

  filter.addEventListener('input', renderCases);
  byId('Daily').onclick = () => setMode('daily');
  byId('Minutes').onclick = () => setMode('minutes');
  byId('Prev').onclick = () => selectIndex(dayIndex - 1);
  byId('EventDay').onclick = () => selectIndex(eventIndex);
  byId('Next').onclick = () => selectIndex(dayIndex + 1);
  canvas.addEventListener('pointermove', event => {
    if (event.pointerType !== 'touch') locatePointer(event);
  });
  canvas.addEventListener('click', locatePointer);
  canvas.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const current = mode === 'daily' ? dayIndex : minuteIndex;
    selectIndex(current + (event.key === 'ArrowLeft' ? -1 : 1));
  });
  new ResizeObserver(draw).observe(canvas);

  async function open() {
    if (!archive) {
      byId('Status').textContent = '正在读取行情归档…';
      loading ??= fetch('./limit-review-data.json').then(response => {
        if (!response.ok) throw new Error('行情归档 HTTP ' + response.status);
        return response.json();
      });
      try {
        archive = await loading;
      } catch (error) {
        loading = undefined;
        byId('Status').textContent = '行情归档加载失败。请重新点击「连板回溯」。';
        console.error(error);
        return;
      }
    }
    if (document.getElementById('marketLimitReview').hidden) return;
    byId('Status').textContent = '已收录 ' + archive.cases.length + ' 个历史案例 · ' + archive.checkedDate + ' 收盘筛查无符合项';
    byId('Layout').hidden = false;
    const params = new URLSearchParams(location.search);
    const linkedCase = archive.cases.find(item => item.symbol === params.get('symbol') && item.date === params.get('date'));
    showCase(linkedCase || selected || archive.cases[0]);
    renderCases();
  }

  return { open, leave };
})();
