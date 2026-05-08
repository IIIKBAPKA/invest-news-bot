const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

const TARGET_COMPANIES = {
    "NVDA": ["NVIDIA"], "GOOG": ["GOOGLE", "ALPHABET"], "VST": ["VISTRA"],
    "AAPL": ["APPLE"], "TSLA": ["TESLA"], "DASH": ["DOORDASH"],
    "NEE": ["NEXTERA"], "UBER": ["UBER"], "CVX": ["CHEVRON"],
    "XOM": ["EXXON"], "ADBE": ["ADOBE"], "AMZN": ["AMAZON"],
    "KO": ["COCA-COLA", "COCA COLA"], "MSFT": ["MICROSOFT"],
    "NFLX": ["NETFLIX"], "META": ["META PLATFORMS", "FACEBOOK"],
    "AMD": ["ADVANCED MICRO DEVICES"], "SPY": ["SPDR S&P 500"],
    "QQQ": ["INVESCO QQQ"], "1VOW3": ["VOLKSWAGEN"]
};

const TARGET_TICKERS = Object.keys(TARGET_COMPANIES);
const ALL_TARGET_NAMES = [...TARGET_TICKERS, ...Object.values(TARGET_COMPANIES).flat()];

const hasTicker = (text) => {
    const upperText = text.toUpperCase();
    return ALL_TARGET_NAMES.some(target => {
        const regex = new RegExp(`\\b${target.toUpperCase()}\\b`, 'i');
        return regex.test(upperText);
    });
};

function isSimilar(s1, s2) {
    const words1 = new Set(s1.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const words2 = new Set(s2.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    if (words1.size === 0 || words2.size === 0) return false;
    let intersection = 0;
    words1.forEach(w => { if (words2.has(w)) intersection++; });
    const overlap = intersection / Math.min(words1.size, words2.size);
    return overlap > 0.7;
}

async function run() {
    try {
        console.log("🚀 Запуск моніторингу (v5.2 Fix Prompt + Smart Dedup)...");
        let allItems = [];
        const today = new Date().toISOString().split('T')[0];

        for (const ticker of TARGET_TICKERS) {
            try {
                const url = `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${today}&to=${today}&token=${FINNHUB_API_KEY}`;
                const res = await fetch(url);
                if (res.ok) {
                    const newsArray = await res.json();
                    const formattedItems = newsArray.map(i => ({
                        title: i.headline,
                        link: i.url,
                        contentSnippet: i.summary,
                        sourceName: i.source || 'Finnhub',
                        pubDate: i.datetime * 1000
                    }));
                    allItems = allItems.concat(formattedItems);
                }
                await new Promise(r => setTimeout(r, 400)); 
            } catch (e) { console.error(`❌ Помилка [${ticker}]:`, e.message); }
        }

        const thirtyFiveMinsAgo = Date.now() - (35 * 60 * 1000); 
        
        const freshAndTargeted = allItems.filter(item => {
            return item.pubDate > thirtyFiveMinsAgo && hasTicker(item.title);
        });

        const uniqueItems = [];
        for (const item of freshAndTargeted) {
            const isDuplicate = uniqueItems.some(u => isSimilar(u.title, item.title));
            if (!isDuplicate) uniqueItems.push(item);
        }

        console.log(`📊 СТАТИСТИКА: Всього ${allItems.length} | Цільових/Свіжих ${freshAndTargeted.length} | Унікальних ${uniqueItems.length}`);

        if (uniqueItems.length === 0) {
            process.exit(0);
        }

        for (const item of uniqueItems.slice(0, 10)) {
            console.log(`----------\nОбробка: ${item.title}`);
            
            let fullText = item.contentSnippet || "";
            try {
                const res = await fetch(`https://r.jina.ai/${item.link}`, { signal: AbortSignal.timeout(15000) });
                if (res.ok) fullText = (await res.text()).slice(0, 8000);
            } catch (e) { console.log("⚠️ Тільки сніпет."); }

            // Твій оригінальний промт без жодних змін
            const prompt = `Ти — Senior інвестиційний аналітик. Глибоко проаналізуй новину. 
            Якщо вона НЕ стосується тікерів: ${TARGET_TICKERS.join(', ')} або новина якась дуже неважлива чи просто якийсь факт що щось виросло без конкретики — відповідай SKIP.

            ВАЖЛИВО: Пиши ТІЛЬКИ чистий текст, але зі смайлами і тегами шаблону (головне щоб цей синтаксис telegram прийняв). 

            КРОК 2: Сформуй звіт (HTML, без Markdown):
            🎯 <b>Головне:</b> [Суть події без води]
            
            🏢 <b>Компанії:</b> [#TICKER]
            📊 <b>Сентимент:</b> [🟢/🔴/🟡]
            🔥 <b>Важливість:</b> [1-10]/10
            
            🧠 <b>Аналіз:</b> [Вплив на ціну акції, логіка руху]
            
            📈 <b>Опціонний кут:</b> [IV та стратегії: Iron Condor, Spreads тощо. Пиши простою мовою, як для новачка]
            
            ⚔️ <b>Конкуренти:</b> [Тікери конкурентів та короткий вплив на них]

            Текст: ${item.title} \n ${fullText}`;

            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-8b" });
            try {
                const result = await model.generateContent(prompt);
                const response = result.response.text().trim();

                if (!response.includes("SKIP")) {
                    let safeResponse = response.replace(/<\/?(?!(b|i|a|code|s|u)\b)[^>]+>/gi, '');
                    const tags = ['b', 'i', 'a', 'code', 's', 'u'];
                    tags.forEach(tag => {
                        const opened = (safeResponse.match(new RegExp(`<${tag}(\\s|>|/)`, 'g')) || []).length;
                        const closed = (safeResponse.match(new RegExp(`</${tag}>`, 'g')) || []).length;
                        if (opened > closed) safeResponse += `</${tag}>`.repeat(opened - closed);
                    });

                    const message = `🔔 <b>Новина:</b> <a href="${item.link}">${item.title}</a>\n\n${safeResponse}`;
                    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML', disable_web_page_preview: true })
                    });
                    console.log("📨 Надіслано.");
                } else console.log("⏭️ SKIP.");
            } catch (err) { console.error("❌ Помилка AI"); }
            
            await new Promise(r => setTimeout(r, 2000));
        }
        process.exit(0);
    } catch (error) { process.exit(1); }
}

run();
