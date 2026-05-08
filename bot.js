const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const parser = new Parser({
    headers: {
        'User-Agent': 'Anton Vereta (anton012@gmail.com)', 
        'Accept': 'application/atom+xml, application/xml, text/xml',
    },
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const TARGET_TICKERS = [
    "NVDA", "GOOG", "VST", "AAPL", "TSLA", "DASH", "NEE", "UBER", 
    "CVX", "XOM", "ADBE", "AMZN", "1VOW3", "KO", "MSFT", 
    "NFLX", "META", "AMD", "SPY", "QQQ"
];

const tickerQuery = TARGET_TICKERS.join(" OR ");
const FEEDS = [
    { name: 'GoogleNews', url: `https://news.google.com/rss/search?q=${encodeURIComponent(tickerQuery)}+when:1d&hl=en-US&gl=US` },
    { name: 'SEC', url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&CIK=&type=&company=&paction=getcurrent&count=40&output=atom' } 
];

const hasTicker = (text) => {
    const upperText = text.toUpperCase();
    return TARGET_TICKERS.some(t => upperText.includes(t));
};

async function run() {
    try {
        console.log("🚀 Запуск моніторингу (Версія: 3.4 Micro-Retries + Fallback)...");
        let allItems = [];
        let sourceStats = {};

        for (const feedSource of FEEDS) {
            try {
                const feed = await parser.parseURL(feedSource.url);
                const items = feed.items.map(i => ({ ...i, sourceName: feedSource.name }));
                allItems = allItems.concat(items);
                sourceStats[feedSource.name] = items.length;
            } catch (e) {
                console.error(`❌ Помилка джерела [${feedSource.name}]:`, e.message);
            }
        }

        const thirtyFiveMinsAgo = Date.now() - (35 * 60 * 1000);
        let passedBySource = { GoogleNews: 0, SEC: 0 };

        const filtered = allItems.filter(item => {
            const pubDate = new Date(item.pubDate || item.isoDate || 0).getTime();
            const isFresh = pubDate > thirtyFiveMinsAgo;
            const isTarget = hasTicker(item.title + " " + (item.contentSnippet || ""));
            
            if (isFresh && isTarget) {
                passedBySource[item.sourceName]++;
                return true;
            }
            return false;
        });

        const uniqueItems = Array.from(new Map(filtered.map(item => [item.title, item])).values());

        console.log(`\n📊 ДЕТАЛЬНА СТАТИСТИКА:`);
        console.log(`- Всього знайдено: ${allItems.length}`);
        Object.keys(sourceStats).forEach(s => console.log(`  [${s}]: ${sourceStats[s]} завантажено`));
        console.log(`- Пройшли фільтр (35хв + Тікер):`);
        Object.keys(passedBySource).forEach(s => console.log(`  [${s}]: ${passedBySource[s]} пройшло`));
        console.log(`- Унікальних для ШІ: ${uniqueItems.length}\n`);

        if (uniqueItems.length === 0) {
            console.log("☕ Нових подій немає. Завершуємо.");
            process.exit(0);
        }

        for (const item of uniqueItems.slice(0, 10)) {
            console.log(`----------\nОбробка [${item.sourceName}]: ${item.title}`);
            
            let fullText = item.contentSnippet || item.description || "";
            if (item.sourceName === 'GoogleNews') {
                try {
                    const res = await fetch(`https://r.jina.ai/${item.link}`, { signal: AbortSignal.timeout(15000) });
                    if (res.ok) {
                        const content = await res.text();
                        fullText = content.slice(0, 8000);
                        console.log("✅ Повний текст отримано.");
                    }
                } catch (e) { console.log("⚠️ Тільки сніпет (Таймаут або Помилка)."); }
            }

            await new Promise(r => setTimeout(r, 4000));

            const prompt = `Ти — Senior інвестиційний аналітик. Глибоко проаналізуй новину. 
            Якщо вона НЕ стосується тікерів: ${TARGET_TICKERS.join(', ')} або новина якась дуже неважлива — відповідай SKIP.

            ВАЖЛИВО: Використовуй ТІЛЬКИ теги <b>, <i>, <a>, <code>, <s>, <u>. 
            КАТЕГОРИЧНО ЗАБОРОНЕНО використовувати <div>, <span>, <p>, <ul>, <li>, <br>, або переноси рядків через HTML. Не використовуй Markdown (**).

            КРОК 2: Сформуй звіт (HTML, без Markdown):
            🎯 <b>Головне:</b> [Суть події без води]
            
            🏢 <b>Компанії:</b> [#TICKER]
            📊 <b>Сентимент:</b> [🟢/🔴/🟡]
            🔥 <b>Важливість:</b> [1-10]/10
            
            🧠 <b>Аналіз:</b> [Вплив на ціну акції, логіка руху]
            
            📈 <b>Опціонний кут:</b> [IV та стратегії: Iron Condor, Spreads тощо. Пиши простою мовою, як для новачка]
            
            ⚔️ <b>Конкуренти:</b> [Тікери конкурентів та короткий вплив на них]

            Текст: ${item.title} \n ${fullText}`;

            let success = false;
            let attempts = 0;
            const MAX_AI_ATTEMPTS = 4; 

            while (!success && attempts < MAX_AI_ATTEMPTS) {
                try {
                    const model = genAI.getGenerativeModel({ model: "gemini-3-flash" });
                    
                    const result = await Promise.race([
                        model.generateContent(prompt),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 40000))
                    ]);

                    const response = result.response.text().trim();

                    if (!response.includes("SKIP")) {
                        // ПРОГРАМНЕ ОЧИЩЕННЯ ТЕГІВ: Залишаємо тільки те, що дозволено Telegram
                        const safeResponse = response.replace(/<\/?(?!(b|i|a|code|s|u)\b)[^>]+>/gi, '');

                        const message = `🔔 <b>Новина:</b> <a href="${item.link}">${item.title}</a>\n\n${safeResponse}`;
                        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML', disable_web_page_preview: true }),
                            signal: AbortSignal.timeout(10000)
                        });
                        console.log("📨 Надіслано в Telegram.");
                    } else {
                        console.log("⏭️ AI вирішив пропустити (SKIP).");
                    }
                    success = true;
                } catch (err) {
                    attempts++;
                    if (err.message.includes("503") || err.message.includes("demand") || err.message === 'TIMEOUT') {
                        const waitTime = 2000; // Фіксована пауза 2 секунд
                        console.log(`⚠️ Помилка AI (Спроба ${attempts}/${MAX_AI_ATTEMPTS}). Чекаємо 2 сек...`);
                        await new Promise(r => setTimeout(r, waitTime));
                        
                        if (attempts === MAX_AI_ATTEMPTS) {
                            console.log("⏭️ Сервер стабільно перевантажений. Відправляємо сирий сніпет новини як Fallback.");
                            
                            const fallbackMsg = `🔔 <b>Новина (Без аналізу ШІ):</b> <a href="${item.link}">${item.title}</a>\n\n<b>Опис:</b> ${item.contentSnippet || "Опис відсутній"}\n\n<i>⚠️ Аналіз недоступний: сервери ШІ перевантажені (503).</i>`;
                            
                            try {
                                await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: fallbackMsg, parse_mode: 'HTML', disable_web_page_preview: true }),
                                    signal: AbortSignal.timeout(10000)
                                });
                                console.log("📨 Фолбек надіслано в Telegram.");
                            } catch (fallbackErr) {
                                console.error("❌ Помилка відправки фолбеку:", fallbackErr.message);
                            }

                            success = true; // Виходимо з циклу
                        }
                    } else {
                        console.error("❌ Фатальна помилка AI:", err.message);
                        success = true; 
                    }
                }
            }
        }
        console.log("✅ Роботу завершено успішно.");
        process.exit(0);
    } catch (error) {
        console.error("💥 Критична помилка виконання:", error);
        process.exit(1);
    }
}

run();
