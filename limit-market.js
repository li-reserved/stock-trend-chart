'use strict';

const limitMarket = (() => {
  const $ = id => document.getElementById('limitMarket' + id);
  const refreshButton = $('Refresh');
  const state = { active: false, pools: new Map(), seen: new Set(), detailRequest: 0 };
  const origin = 'https://push2.eastmoney.com/api/qt/';
  const history = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
  const cnClock = () => new Date(Date.now() + 8 * 3600000).toISOString();
  const isoDate = value => value.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  const fmt = (value, suffix) => Number.isFinite(value) ? value.toFixed(2) + suffix : '—';
  const symbol = row => row.m + '.' + row.c;
  const mainland = row => /^(00[0-3]|60[0135])\d{3}$/.test(row.c) && !/ST/.test(row.n);

  async function data(endpoint, params) {
    const url = new URL(endpoint);
    url.search = new URLSearchParams(params);
    const response = await fetch(url, { signal: AbortSignal.timeout(6000), cache: 'no-store' });
    if (!response.ok) throw new Error('行情 HTTP ' + response.status);
    const result = await response.json();
    if (!result.data) throw new Error('行情暂未返回有效数据');
    return result.data;
  }

  async function days(symbol, begin = '0', end = '20500101', limit = 96) {
    const result = await data(history, {
      secid: symbol, klt: 101, fqt: 0, beg: begin.replaceAll('-', ''), end: end.replaceAll('-', ''),
      lmt: limit, fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'
    });
    return result.klines.map(line => {
      const [date, open, close, high, low, volume, amount, , change, , turnover] = line.split(',');
      return { date, open: +open, close: +close, high: +high, low: +low, volume: +volume, amount: +amount, change: +change, turnover: +turnover };
    });
  }

  async function intraday(symbol, date) {
    const result = await data(origin + 'stock/trends2/get', {
      secid: symbol, iscr: 0, ndays: 5,
      fields1: 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13', fields2: 'f51,f52,f53,f54,f55,f56,f57,f58'
    });
    let opening = 0;
    const minutes = [];
    for (const line of result.trends) {
      const [stamp, , close, , , volume] = line.split(',');
      if (stamp.slice(0, 10) !== date) continue;
      const time = stamp.slice(11, 16);
      if (time === '09:30') opening = Number(volume);
      else if ((time >= '09:31' && time <= '11:30') || (time >= '13:01' && time <= '15:00')) {
        const [h, m] = time.split(':').map(Number);
        const step = h * 60 + m - (h < 13 ? 570 : 660);
        if (step !== minutes.length + 1 || !Number.isFinite(+close) || !Number.isFinite(+volume)) {
          throw new Error(date + ' 分时有缺口');
        }
        minutes.push([Math.round(Number(close) * 100), Number(volume) + (step === 1 ? opening : 0)]);
      }
    }
    if (!minutes.length) throw new Error(date + ' 暂无可回放的分钟行情');
    return minutes;
  }

  async function calendar() {
    const result = await data('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get', { param: 'sh000001,day,,,4,' });
    return result.sh000001.day.map(([date]) => date);
  }

  async function pool(date, failed = false) {
    const result = await data('https://push2ex.eastmoney.com/' + (failed ? 'getTopicZBPool' : 'getTopicZTPool'), {
      date: date.replaceAll('-', ''), ut: '7eea3edcaed734bea9cbfc24409ed989', dpt: 'wz.ztzt', Pageindex: 0, pagesize: 300, sort: 'fbt:asc'
    });
    if (isoDate(String(result.qdate)) < date || !Array.isArray(result.pool)) throw new Error('涨停池日期未更新');
    return result.pool;
  }

  function priorPool(date) {
    if (state.pools.has(date)) return state.pools.get(date);
    return pool(date).then(rows => {
      state.pools.clear();
      state.pools.set(date, rows);
      return rows;
    });
  }

  function watchTime() {
    const now = cnClock();
    const weekday = new Date(now).getUTCDay();
    const clock = now.slice(11, 16);
    return weekday >= 1 && weekday <= 5 &&
      ((clock >= '09:25' && clock <= '11:31') || (clock >= '13:00' && clock <= '15:06'));
  }

  function confirmed(date) {
    const now = cnClock();
    return date < now.slice(0, 10) || now.slice(11, 16) >= '15:01';
  }

  async function compare(entry, date, priorDate) {
    const history = await days(symbol(entry.row), priorDate, date, 6);
    const day = history.find(bar => bar.date === date);
    const prev = history.find(bar => bar.date === priorDate);
    if (!prev || !(prev.volume > 0) || !day || !(day.volume > 0)) throw new Error('当日量价尚未对齐');
    const limitPrice = (entry.row.ztp || entry.row.p) / 1000;
    const ratio = day.volume / prev.volume;
    const avgRatio = day.amount / (day.volume * 100) / limitPrice;
    const oneWord = prev.open === prev.close && prev.close === prev.high && prev.high === prev.low;
    return {
      ratio,
      matches: oneWord && entry.row.zbc > 0 && entry.row.hs >= 15 && ratio >= 7 && avgRatio >= .975
    };
  }

  function render(snapshot) {
    const { date, rows, archived, warning } = snapshot;
    const closed = archived || confirmed(date);
    const height = Math.max(0, ...rows.filter(x => !x.failed).map(x => x.boards));
    const status = date + ' · ' + (archived ? '收盘存档' : closed ? '收盘' : '盘中') +
      ' · 最高 ' + height + ' 板' + (snapshot.checked ? ' · 刷新于 ' + snapshot.checked : '');
    $('Status').textContent = status + (warning ? ' · ' + warning : '');
    const candidates = rows.filter(x => x.matches && (!closed || !x.failed));
    const newlySeen = candidates.filter(x => !state.seen.has(date + ':' + symbol(x.row)));
    for (const x of newlySeen) state.seen.add(date + ':' + symbol(x.row));
    $('Signal').textContent = candidates.length
      ? (newlySeen.length ? '新出现 ' + newlySeen.map(x => x.row.n).join('、') + ' · ' : '') +
        candidates.length + ' 只达到量价条件'
      : warning ? '部分数据尚未核对' : '当前暂无符合上次条件的个股';
    const table = document.createElement('table');
    table.className = 'dash-table';
    table.innerHTML = '<thead><tr><th>股票</th><th>连板高度</th><th>换手率</th><th>量 / 前日</th><th>封板状态</th><th>复盘</th></tr></thead>';
    const body = table.createTBody();
    for (const entry of rows) {
      const { row, boards, failed, ratio, matches } = entry;
      const tr = body.insertRow();
      tr.toggleAttribute('data-match', Boolean(matches && (!closed || !failed)));
      const label = tr.insertCell();
      label.textContent = row.n;
      const code = document.createElement('small');
      code.textContent = row.c;
      label.append(code);
      const boardText = failed ? boards + '板未封' : boards + (closed ? '连板' : '板待确认');
      const signal = failed ? (closed ? '收盘未封' : '已开板 · 待回封')
        : row.zbc > 0 ? (matches ? (closed ? '符合条件' : '候选 · 已回封') : '已回封')
          : '封板';
      for (const value of [boardText, fmt(row.hs, '%'), fmt(ratio, '倍'), signal]) tr.insertCell().textContent = value;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dash-text-button';
      button.textContent = '查看';
      button.setAttribute('aria-label', '查看 ' + row.n);
      button.onclick = () => view(entry, date, button);
      tr.insertCell().append(button);
    }
    $('Rows').className = 'table-scroll';
    $('Rows').replaceChildren(table);
  }

  async function view(entry, date, button) {
    const id = symbol(entry.row);
    const requested = ++state.detailRequest;
    const existing = state.seed?.cases.find(item => item.date === date && item.symbol === id);
    if (button) {
      button.disabled = true;
      button.textContent = '读取中…';
    }
    try {
      const item = existing || {
        symbol: id, date, name: entry.row.n, streak: entry.boards, live: true,
        failed: entry.failed, daily: await days(id, '0', date), minutes: await intraday(id, date)
      };
      const eventIndex = item.daily.findIndex(day => day.date === date);
      if (eventIndex < 1) throw new Error('缺少对应交易日日线或前一日量价');
      if (state.active && requested === state.detailRequest) state.showCase(item);
    } catch (error) {
      if (state.active && requested === state.detailRequest) $('Signal').textContent = entry.row.n + ' 分时读取失败 · ' + error.message;
      console.error(error);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = '查看';
      }
    }
  }

  async function refresh() {
    if (!state.active || state.refreshing) return;
    state.refreshing = true;
    refreshButton.disabled = true;
    try {
      const dates = await calendar();
      const date = dates.at(-1);
      const previous = dates.at(-2);
      const [current, failed, prior] = await Promise.allSettled([pool(date), pool(date, true), priorPool(previous)]);
      if (current.status === 'rejected') throw current.reason;
      const rows = current.value.filter(row => mainland(row) && row.lbc >= 2)
        .map(row => ({ row, boards: row.lbc }));
      if (failed.status === 'fulfilled' && prior.status === 'fulfilled') {
        const byCode = new Map(prior.value.map(row => [symbol(row), row.lbc]));
        for (const row of failed.value) {
          const boards = byCode.get(symbol(row)) + 1;
          if (mainland(row) && boards >= 4 && !rows.some(x => symbol(x.row) === symbol(row))) rows.push({ row, boards, failed: true });
        }
      }
      rows.sort((a, b) => b.boards - a.boards || Number(!!a.failed) - Number(!!b.failed) || a.row.fbt - b.row.fbt);
      const checks = rows.filter(x => x.boards >= 4 && x.boards <= 5);
      const verified = await Promise.allSettled(checks.map(x => compare(x, date, previous)));
      verified.forEach((result, index) => {
        if (result.status === 'fulfilled') Object.assign(checks[index], result.value);
        else console.warn('连板量价核对失败', symbol(checks[index].row), result.reason);
      });
      if (!state.active) return;
      const warning = [failed, prior, ...verified].some(x => x.status === 'rejected') ? '部分候选尚未核对' : '';
      render(state.snapshot = { date, rows, checked: cnClock().slice(11, 19), warning });
      if (state.linked?.date === date) {
        const entry = rows.find(x => symbol(x.row) === state.linked.symbol);
        state.linked = null;
        if (entry) view(entry, date);
      }
    } catch (error) {
      if (state.active) $('Status').textContent = (state.snapshot?.date || '') + ' · 刷新未成功 · ' + (error instanceof TypeError ? '行情接口暂不可连接' : error.message);
    } finally {
      state.refreshing = false;
      refreshButton.disabled = false;
    }
  }

  async function open(showCase, linked) {
    if (state.active) return;
    state.active = true;
    state.showCase = showCase;
    state.linked = linked;
    try {
      if (!state.seed) {
        const response = await fetch('./limit-market-data.json');
        if (!response.ok) throw new Error('收盘存档未加载');
        state.seed = await response.json();
      }
      const item = state.seed.cases.find(x => x.symbol === state.linked?.symbol && x.date === state.linked.date);
      if (state.active && item) {
        state.linked = null;
        state.showCase(item);
      }
      if (state.active && !state.snapshot) render(state.snapshot = {
        date: state.seed.date, archived: true,
        rows: state.seed.pool.filter(row => mainland(row) && row.lbc >= 2)
          .map(row => ({ row, boards: row.lbc })).sort((a, b) => b.boards - a.boards || a.row.fbt - b.row.fbt)
      });
    } catch (error) {
      if (state.active) $('Status').textContent = error.message;
    }
    if (state.active) refresh();
  }

  refreshButton.onclick = refresh;
  setInterval(() => {
    if (state.active && !document.hidden && watchTime()) refresh();
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && watchTime()) refresh();
  });

  function cancelCase() {
    state.linked = null;
    state.detailRequest++;
  }

  function leave() {
    state.active = false;
    cancelCase();
  }

  return { open, leave, cancelCase, intraday };
})();
