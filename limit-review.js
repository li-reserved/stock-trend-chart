'use strict';

const limitReview = (() => {
  const byId = id => document.getElementById('limitReview' + id);
  const filter = byId('Filter');
  const caseList = byId('Cases');
  const canvas = byId('Chart');
  const dailyReplayCanvas = byId('DailyChart');
  const replayDate = byId('ReplayDate');
  const seek = byId('Seek');
  const speed = byId('Speed');
  const play = byId('Play');
  const ink = { text: '#a1b0c5', grid: '#28374d', accent: '#7bd9cd', up: '#ff747b', down: '#49d9ae', neutral: '#8ea4c0' };
  const money = value => value.toFixed(2);
  const lots = value => value >= 10000 ? (value / 10000).toFixed(2) + ' 万手' : value.toLocaleString('zh-CN') + ' 手';
  const percent = value => value.toFixed(2) + '%';
  let archive, loading, selected;
  let mode = 'daily', eventIndex = 0, dayIndex = 0, dailyEnd = 0, minuteStep = 0;
  let chartBounds, cumulativeVolume, playbackTimer;
  let replayIndex = 0, replayMinutes = [], replayRequest = 0;

  function locateCase(item) {
    const address = new URL(location.href);
    address.searchParams.set('view', 'limit-review');
    address.searchParams.set('symbol', item.symbol);
    address.searchParams.set('date', item.date);
    history.replaceState(history.state, '', address);
  }

  function leave() {
    stopPlayback();
    replayRequest++;
    limitMarket.leave();
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
        limitMarket.cancelCase();
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
    dailyEnd = item.daily.length;
    replayRequest++;
    byId('ReplayStatus').hidden = true;
    replayDate.replaceChildren(...item.daily.slice(eventIndex).map(day => new Option(day.date, day.date)));
    loadReplay(eventIndex, item.minutes);
    const day = item.daily[eventIndex];
    const previous = item.daily[eventIndex - 1];
    const average = day.amount / (day.volume * 100);
    byId('Name').textContent = item.name + ' · ' + item.symbol.slice(2);
    byId('Date').textContent = item.date + ' · ' + (item.live ? '连板梯队 · ' + item.streak + ' 板' : item.streak + ' 连板');
    const ticker = (item.symbol.startsWith('1.') ? 'sh' : 'sz') + item.symbol.slice(2);
    byId('Source').href = item.source || 'https://quote.eastmoney.com/' + ticker + '.html';
    const opening = item.firstSeal ? item.firstSeal + ' 首封' : '涨停开盘';
    byId('Event').textContent = item.live ? '最近交易日量价与分时回放'
      : previous.date + ' 一字板 → ' + opening + ' → 开板换手 → 收盘封板';
    const metrics = [
      ['前一日 → 当日换手率', percent(previous.turnover) + ' → ' + percent(day.turnover)],
      ['成交量 / 前一日', (day.volume / previous.volume).toFixed(2) + ' 倍'],
      ['成交均价 / 涨停价', percent(average / upperLimit(previous.close) * 100)]
    ];
    byId('Metrics').innerHTML = metrics.map(([label, value]) => '<div><dt>' + label + '</dt><dd>' + value + '</dd></div>').join('');
    locateCase(item);
    setMode('daily');
  }

  const upperLimit = previous => Math.floor((Math.round(previous * 100) * 110 + 50) / 100) / 100;

  function loadReplay(index, rows) {
    replayIndex = index;
    minuteStep = 0;
    replayMinutes = rows;
    replayDate.value = selected.daily[index].date;
    seek.max = rows.length;
    cumulativeVolume = [0];
    for (const [, volume] of rows) cumulativeVolume.push(cumulativeVolume.at(-1) + volume);
    stopPlayback();
  }

  async function openReplay(index) {
    const item = selected, day = item.daily[index];
    const status = byId('ReplayStatus');
    const request = ++replayRequest;
    stopPlayback();
    if (index === replayIndex) {
      status.hidden = true;
      dayIndex = index;
      setMode('minutes');
      return;
    }
    const archived = index === eventIndex ? item.minutes : item.replays?.[day.date];
    try {
      if (!archived) {
        status.hidden = false;
        status.textContent = '正在读取 ' + day.date + ' 分时…';
      }
      const minutes = archived || await limitMarket.intraday(item.symbol, day.date);
      if (request !== replayRequest) return;
      loadReplay(index, minutes);
      dayIndex = index;
      status.hidden = true;
      setMode('minutes');
    } catch (error) {
      if (request !== replayRequest) return;
      status.hidden = false;
      status.textContent = error.message;
      replayDate.value = item.daily[replayIndex].date;
    }
  }

  function setMode(value) {
    mode = value;
    const daily = mode === 'daily';
    if (daily) stopPlayback();
    byId('Daily').setAttribute('aria-pressed', daily);
    byId('Minutes').setAttribute('aria-pressed', !daily);
    byId('Step').hidden = !daily;
    byId('Readout').hidden = !daily;
    byId('Metrics').hidden = !daily;
    byId('Event').hidden = !daily;
    byId('Replay').hidden = daily;
    byId('DailyReplay').hidden = daily;
    byId('Charts').toggleAttribute('data-replay', !daily);
    canvas.setAttribute('aria-describedby', daily ? 'limitReviewReadout' : 'limitReviewLive');
    renderSelection();
  }

  function minuteLabel(step) {
    const total = step <= 120 ? 9 * 60 + 30 + step : 13 * 60 + step - 120;
    return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
  }

  function stopPlayback() {
    clearInterval(playbackTimer);
    playbackTimer = undefined;
    play.textContent = selected && minuteStep === replayMinutes.length ? '重播' : '播放';
  }

  function startPlayback() {
    if (minuteStep === replayMinutes.length) setMinute(0);
    play.textContent = '暂停';
    playbackTimer = setInterval(() => setMinute(minuteStep + 1), 1000 / Number(speed.value));
  }

  function setMinute(step) {
    minuteStep = Math.max(0, Math.min(replayMinutes.length, step));
    if (minuteStep === replayMinutes.length) stopPlayback();
    renderSelection();
  }

  function seekTo(step) {
    setMinute(step);
    stopPlayback();
  }

  function renderSelection() {
    if (mode === 'daily') {
      const b = selected.daily[dayIndex];
      const tag = dayIndex === eventIndex ? ' · 换手日' : dayIndex === eventIndex - 1 ? ' · 前一日一字板' : '';
      const change = (b.change > 0 ? '+' : '') + percent(b.change);
      byId('Readout').textContent = b.date + tag + '　开 ' + money(b.open) + '　高 ' + money(b.high) +
        '　低 ' + money(b.low) + '　收 ' + money(b.close) + '（' + change + '）　量 ' + lots(b.volume) + '　换手 ' + percent(b.turnover);
      byId('Prev').disabled = dayIndex === 0;
      byId('Next').disabled = dayIndex === selected.daily.length - 1;
      byId('EventDay').disabled = dayIndex === eventIndex;
      byId('Minutes').disabled = dayIndex < eventIndex;
    } else {
      const day = selected.daily[replayIndex];
      const previous = selected.daily[replayIndex - 1];
      const [price, volume] = minuteStep ? replayMinutes[minuteStep - 1] : [day.open * 100, 0];
      const change = (price / 100 / previous.close - 1) * 100;
      const time = minuteLabel(minuteStep);
      const total = cumulativeVolume[minuteStep];
      seek.value = minuteStep;
      seek.setAttribute('aria-valuetext', time);
      byId('Time').textContent = time;
      const priceOutput = byId('Price');
      priceOutput.classList.toggle('up', change > 0);
      priceOutput.classList.toggle('down', change < 0);
      priceOutput.textContent = money(price / 100) + ' 元 / ' + (change > 0 ? '+' : '') + percent(change);
      byId('MinuteVolume').textContent = minuteStep ? lots(volume) : '—';
      byId('TotalVolume').textContent = minuteStep ? lots(total) : '—';
      byId('Turnover').textContent = minuteStep ? percent(total / day.volume * day.turnover) : '—';
    }
    draw();
  }

  function draw() {
    drawChart(canvas, mode);
    if (mode === 'minutes') drawChart(dailyReplayCanvas, 'dailyReplay');
  }

  function drawChart(target, chartMode) {
    const isDaily = chartMode !== 'minutes';
    const replayDaily = chartMode === 'dailyReplay';
    const width = target.clientWidth, height = target.clientHeight;
    if (!selected || !width || !height) return;
    const ratio = window.devicePixelRatio;
    const pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio);
    if (target.width !== pixelWidth || target.height !== pixelHeight) {
      target.width = pixelWidth;
      target.height = pixelHeight;
    }
    const ctx = target.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = '11px system-ui, sans-serif';
    const allDays = selected.daily;
    const shownMinutes = replayMinutes.slice(0, minuteStep);
    const day = allDays[replayIndex], previous = allDays[replayIndex - 1];
    const previousClose = previous.close, limitPrice = upperLimit(previousClose);
    const left = 9, right = width - (replayDaily ? 68 : 53), top = 27;
    const chartWidth = right - left;
    let offset = 0, days = allDays;
    if (isDaily) {
      const density = width >= 600 ? 11 : 9;
      const visibleCount = Math.max(1, Math.floor(chartWidth / density));
      if (!replayDaily) {
        if (dayIndex < dailyEnd - visibleCount) dailyEnd = dayIndex + visibleCount;
        if (dayIndex >= dailyEnd) dailyEnd = dayIndex + 1;
        dailyEnd = Math.min(allDays.length, Math.max(visibleCount, dailyEnd));
      }
      const end = replayDaily ? replayIndex + 1 : dailyEnd;
      offset = Math.max(0, end - visibleCount);
      days = allDays.slice(offset, end);
    }
    const count = isDaily ? days.length : 240;
    const low = isDaily ? Math.min(...days.map(bar => bar.low)) : Math.min(day.low, Math.round(previousClose * 90) / 100);
    const high = isDaily ? Math.max(...days.map(bar => bar.high)) : Math.max(limitPrice, day.high);
    const peakVolume = Math.max(0, ...(isDaily ? days.map(bar => bar.volume) : shownMinutes.map(bar => bar[1])));
    const pad = Math.max((high - low) * 0.065, 0.01);
    const min = low - pad, max = high + pad;
    const priceBottom = Math.round(height * 0.66), volTop = priceBottom + 25, bottom = height - 22;
    const step = chartWidth / count;
    const x = index => left + (index + (isDaily ? 0.5 : 0)) * step;
    const y = price => priceBottom - (price - min) / (max - min) * (priceBottom - top);
    const v = volume => bottom - volume / Math.max(1, peakVolume) * (bottom - volTop);
    if (!replayDaily) chartBounds = { left, step, count, offset };
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

    label(replayDaily ? '日 K · 回放至 ' + minuteLabel(minuteStep)
      : isDaily ? '日 K · 不复权' : '分时 · 分钟末价', left, 16);
    label('元', right + 7, 16);
    const volumeInLots = peakVolume < 10000;
    const volumeLabel = replayDaily ? '日成交量' : '成交量';
    label(volumeLabel + (volumeInLots ? '（手）' : '（万手）'), left, volTop - 7);
    const prices = isDaily
      ? Array.from({ length: 5 }, (_, i) => low + (high - low) * i / 4)
      : [low, (low + previousClose) / 2, previousClose, (previousClose + high) / 2, high];
    for (const price of prices) {
      line(left, y(price), right, y(price), ink.grid);
      label(money(price), right + 5, y(price) + 4);
    }
    line(left, bottom, right, bottom, ink.grid);
    label(volumeInLots ? String(peakVolume) : (peakVolume / 10000).toFixed(2), right + 5, volTop + 4);

    if (isDaily) {
      if (replayDaily) {
        // Keep the axes fixed while the current candle and volume bar grow.
        const prices = [day.open, ...shownMinutes.map(([price]) => price / 100)];
        const current = minuteStep === 240 ? day : {
          ...day,
          high: Math.max(...prices),
          low: Math.min(...prices),
          close: prices.at(-1),
          change: prices.at(-1) - previousClose
        };
        days[days.length - 1] = { ...current, volume: cumulativeVolume[minuteStep] };
      }
      const event = eventIndex - offset;
      const highlighted = replayDaily ? replayIndex - offset : event;
      if (highlighted >= 0 && highlighted < count) {
        ctx.fillStyle = '#7bd9cd23';
        ctx.fillRect(x(highlighted) - step / 2, top - 4, step, bottom - top + 4);
      }
      const w = Math.min(step * 0.72, 9);
      const first = event - selected.streak + 1;
      for (const [i, bar] of days.entries()) {
        const bullish = bar.close === bar.open ? bar.change >= 0 : bar.close >= bar.open;
        const color = bullish ? ink.up : ink.down;
        line(x(i), y(bar.high), x(i), y(bar.low), color);
        ctx.fillStyle = color;
        ctx.fillRect(x(i) - w / 2, y(Math.max(bar.open, bar.close)), w, Math.max(2, Math.abs(y(bar.open) - y(bar.close))));
        ctx.fillRect(x(i) - w / 2, v(bar.volume), w, bottom - v(bar.volume));
        if (i === highlighted || (!selected.live && i === first)) {
          const tag = i === highlighted ? (replayDaily ? '回放日' : selected.streak + '板') : '首板';
          label(tag, x(i), y(bar.high) - 7, i === highlighted ? ink.accent : ink.up, 'center');
        }
      }
      if (replayDaily) {
        const multiple = (cumulativeVolume[minuteStep] / previous.volume).toFixed(2);
        const yLabel = Math.max(volTop + 19, Math.min(bottom - 4, v(cumulativeVolume[minuteStep]) + 4));
        label(multiple + '× 前日', right + 5, yLabel, ink.accent);
      }
      const spacing = Math.ceil(52 / step);
      const start = highlighted >= 0 && highlighted < count ? highlighted % spacing : 0;
      for (let i = start; i < count; i += spacing) {
        const position = x(i);
        const align = position < left + 19 ? 'left' : position > right - 19 ? 'right' : 'center';
        label(days[i].date.slice(5), position, height - 6, i === highlighted ? ink.accent : ink.text, align);
      }
    } else {
      ctx.setLineDash([4, 4]);
      line(left, y(limitPrice), right, y(limitPrice), ink.accent);
      line(left, y(previousClose), right, y(previousClose), ink.neutral);
      ctx.setLineDash([]);
      label('涨停', right - 4, y(limitPrice) - 5, ink.accent, 'right');
      label('昨收', right - 4, y(previousClose) - 5, ink.text, 'right');
      const barWidth = Math.min(step, Math.max(1, step * 0.83));
      for (const [i, [price, volume]] of shownMinutes.entries()) {
        const previous = i ? shownMinutes[i - 1][0] : day.open * 100;
        ctx.fillStyle = price > previous ? ink.up : price < previous ? ink.down : ink.neutral;
        ctx.fillRect(x(i + 1) - barWidth, v(volume), barWidth, bottom - v(volume));
      }
      ctx.strokeStyle = '#8eb5ff';
      ctx.lineWidth = 1.35;
      ctx.beginPath();
      ctx.moveTo(x(0), y(day.open));
      for (const [i, [price]] of shownMinutes.entries()) ctx.lineTo(x(i + 1), y(price / 100));
      ctx.stroke();
      ctx.lineWidth = 1;
      const ticks = [[0, '09:30', 'left'], [120, '11:30 / 13:00', 'center'], [count, '15:00', 'right']];
      if (width >= 480) ticks.push([60, '10:30', 'center'], [180, '14:00', 'center']);
      for (const [position, text, align] of ticks) label(text, x(position), height - 6, ink.text, align);
    }

    const cursor = isDaily ? (replayDaily ? count - 1 : dayIndex - offset) : minuteStep;
    const selectedPrice = isDaily ? days[cursor].close : minuteStep ? shownMinutes.at(-1)[0] / 100 : day.open;
    ctx.setLineDash([3, 3]);
    line(x(cursor), top - 5, x(cursor), bottom, '#a1b0c5b5');
    ctx.setLineDash([]);
    ctx.fillStyle = ink.accent;
    ctx.beginPath();
    ctx.arc(x(cursor), y(selectedPrice), 3, 0, 2 * Math.PI);
    ctx.fill();
  }

  function selectDay(index) {
    dayIndex = Math.max(0, Math.min(selected.daily.length - 1, index));
    renderSelection();
  }

  function locatePointer(event) {
    const { left, step, count, offset } = chartBounds;
    const position = (event.offsetX - left) / step;
    if (position < 0 || position > count) return;
    if (mode === 'daily') {
      const index = offset + Math.min(count - 1, Math.floor(position));
      if (index !== dayIndex) selectDay(index);
    } else {
      seekTo(Math.round(position));
    }
  }

  filter.addEventListener('input', renderCases);
  byId('Daily').onclick = () => {
    replayRequest++;
    byId('ReplayStatus').hidden = true;
    setMode('daily');
  };
  byId('Minutes').onclick = () => {
    if (mode !== 'minutes') openReplay(dayIndex);
  };
  replayDate.addEventListener('change', () => openReplay(selected.daily.findIndex(day => day.date === replayDate.value)));
  byId('Prev').onclick = () => selectDay(dayIndex - 1);
  byId('EventDay').onclick = () => {
    dailyEnd = selected.daily.length;
    selectDay(eventIndex);
  };
  byId('Next').onclick = () => selectDay(dayIndex + 1);
  play.onclick = () => {
    if (playbackTimer) stopPlayback();
    else startPlayback();
  };
  byId('Restart').onclick = () => {
    seekTo(0);
    startPlayback();
  };
  seek.addEventListener('input', () => seekTo(Number(seek.value)));
  speed.addEventListener('change', () => {
    if (playbackTimer) {
      stopPlayback();
      startPlayback();
    }
  });
  canvas.addEventListener('pointermove', event => {
    if (mode === 'daily' && event.pointerType !== 'touch') locatePointer(event);
  });
  canvas.addEventListener('click', locatePointer);
  canvas.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const offset = event.key === 'ArrowLeft' ? -1 : 1;
    if (mode === 'daily') selectDay(dayIndex + offset);
    else seekTo(minuteStep + offset);
  });
  new ResizeObserver(draw).observe(canvas);

  async function open() {
    if (!archive) {
      byId('Status').textContent = '正在读取行情归档…';
      loading ??= fetch('./limit-review-data.json?v=4').then(response => {
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
    limitMarket.open(item => {
      showCase(item);
      renderCases();
      byId('Name').scrollIntoView({ block: 'start' });
    }, linkedCase ? null : { symbol: params.get('symbol'), date: params.get('date') });
  }

  return { open, leave };
})();
