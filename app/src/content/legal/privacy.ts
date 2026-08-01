import type { LegalDocByLang } from './types';

/**
 * Privacy Policy (RU + EN), version 1.1 — the text the owner approved for
 * publication. Every "write to us" pointer resolves to the project bot
 * @korea_rabota_bot (Settings also exposes it as a tappable row).
 */
export const PRIVACY_POLICY: LegalDocByLang = {
  ru: {
    meta: 'Версия: 1.1 · Дата вступления в силу: 01.08.2026',
    intro:
      'Мы написали эту политику сами, простым языком, без привлечения профессионального юриста — специально, чтобы её было легко прочитать и понять. Если что-то осталось неясным или вызывает вопросы — напиши нам: @korea_rabota_bot.',
    sections: [
      {
        heading: 'Кто мы и как с нами связаться',
        blocks: [
          {
            type: 'p',
            text: 'Это мини-приложение «Корея — вакансии» и бот @korea_rabota_bot ведёт физическое лицо — без статуса ИП и без образования компании. По любым вопросам о твоих данных и об этой политике пиши: @korea_rabota_bot.',
          },
        ],
      },
      {
        heading: 'Какие данные мы собираем',
        blocks: [
          {
            type: 'p',
            text: 'Мы собираем разные данные — в зависимости от того, как ты пользуешься приложением: просто смотришь вакансии или сам размещаешь объявление.',
          },
          {
            type: 'p',
            text: '**Чтобы приложение работало и чтобы честно начислять баллы за приглашения, для каждого пользователя мы собираем:**',
          },
          {
            type: 'ul',
            items: [
              '**Telegram ID** — уникальный номер твоего аккаунта в Telegram, чтобы узнавать тебя при следующем визите.',
              '**Имя и username** — как тебя зовут в Telegram (согласно твоим настройкам приватности).',
              '**Язык интерфейса** — на каком языке показывать тебе приложение.',
              '**Твои фильтры и настройки** — города и типы работы, по которым ты хочешь получать вакансии, и настройки уведомлений.',
              '**Кто кого пригласил** — цепочка приглашений до трёх уровней: кто пригласил тебя, кто пригласил того, кто пригласил тебя, и ещё на один уровень выше.',
              '**Открытия контактов** — что ты открыл контакт работодателя: и самый первый раз (по нему начисляются баллы тому, кто тебя пригласил), и последующие. Саму переписку с работодателем мы не видим и не храним.',
              '**Баллы** — сколько у тебя накоплено и за что начислено.',
              '**Что ты делал в приложении** — какие вакансии сохранил в избранное, какие контакты и когда открывал, какие уведомления мы тебе отправили. Это нужно, чтобы показывать избранное, не слать одно и то же дважды и соблюдать суточный лимит на открытие контактов.',
              '**Жалобы и обращения** — если ты жалуешься на вакансию, оставляешь заявку в разделе «Партнёрам» или пишешь нам в бот, мы сохраняем твоё сообщение и способ связи, чтобы разобраться и ответить. Сообщение, отправленное в бот, приходит в личный чат Telegram того, кто ведёт сервис.',
              '**Технические логи сервера** — IP-адрес и время твоих запросов к приложению, как у любого сайта или онлайн-сервиса. Это нужно для работы и защиты серверов; отдельно мы эти логи не анализируем и решений о тебе на их основе не принимаем.',
              '**Откуда ты пришёл** — если ты открыл приложение по одной из наших ссылок (например, из рекламы или с флаера), мы сохраняем короткую пометку об этой ссылке (например, «ads_ru1»). Она одна на всех, кто пришёл оттуда же, записывается только при первом входе и больше не меняется. Мы не записываем в неё ничего о тебе и никому её не показываем — ни другим пользователям, ни рекламным площадкам: она нужна нам, чтобы считать, сколько людей приводит та или иная ссылка.',
            ],
          },
          { type: 'p', text: '**Если ты размещаешь своё объявление о работе**' },
          {
            type: 'p',
            text: 'Когда ты создаёшь объявление через раздел «Разместить вакансию», ты сам добавляешь к своим данным:',
          },
          {
            type: 'ul',
            items: [
              '**Контакт для связи** — телефон, KakaoTalk ID, WhatsApp, Telegram-ник или другой способ связи, который ты указал, чтобы соискатели могли с тобой связаться.',
              '**Текст объявления** — заголовок, описание вакансии, зарплата, график, условия проживания и питания, город и другие поля, которые ты заполнил в форме размещения.',
            ],
          },
          {
            type: 'p',
            text: 'Мы **не запрашиваем** у тебя документы, паспортные данные или банковские реквизиты — ни для использования приложения, ни для размещения объявления. Исключение — контакт для связи в объявлении: его ты добавляешь сам и по собственному выбору, когда решаешь разместить объявление.',
          },
        ],
      },
      {
        heading: 'Кто видит контакт из твоего объявления',
        blocks: [
          {
            type: 'p',
            text: 'Когда соискатель нажимает кнопку «Показать контакт» на твоём объявлении, ему показывается контакт, который ты указал при размещении — телефон, KakaoTalk, WhatsApp, Telegram-ник или другой способ связи. Это происходит по твоему собственному решению: ты сам выбираешь, размещать объявление с контактом или нет, и сам выбираешь, какой контакт указать.',
          },
          {
            type: 'p',
            text: 'Контакт видит любой пользователь приложения, который открыл именно это объявление и нажал «Показать контакт» — отдельного общего списка контактов мы не ведём. Мы ограничиваем число раскрытий контактов в сутки на одного пользователя, чтобы затруднить массовый сбор контактов, но полностью исключить это технически невозможно — учитывай это, решая, какой контакт указать в объявлении.',
          },
        ],
      },
      {
        heading: 'Вакансии из открытых телеграм-чатов',
        blocks: [
          {
            type: 'p',
            text: 'Кроме объявлений, которые пользователи размещают через приложение, мы собираем вакансии из открытых (публичных) телеграм-чатов и каналов, где работодатели и рекрутёры сами публикуют объявления о работе.',
          },
          {
            type: 'p',
            text: 'Это значит, что часть контактов в приложении принадлежит людям, которые самим приложением не пользуются и отдельного согласия нам не давали, — мы берём их из уже опубликованного сообщения в открытом чате, доступном любому участнику.',
          },
          {
            type: 'p',
            text: 'Мы автоматически разбираем текст таких сообщений (в том числе с помощью технологий искусственного интеллекта), убираем часть очевидных контактов из текста описания вакансии и отдельно показываем контакт по кнопке «Показать контакт», если его можно было разобрать из исходного сообщения.',
          },
          {
            type: 'p',
            text: 'Если ты — работодатель, рекрутёр или любой другой человек и увидел в приложении свой контакт из такого чата и хочешь, чтобы мы его убрали, — напиши нам @korea_rabota_bot со ссылкой на объявление или его описанием. Мы уберём контакт из приложения в течение 3 рабочих дней — без лишних вопросов.',
          },
        ],
      },
      {
        heading: 'Зачем нам эти данные',
        blocks: [
          {
            type: 'ol',
            items: [
              '**Чтобы приложение работало:** показывать подходящие вакансии, присылать уведомления о новых вакансиях в выбранных городах, запоминать твои настройки.',
              '**Чтобы честно вести реферальную программу:** начислять баллы за приглашения и показывать твой прогресс.',
              '**Чтобы публиковать твои объявления:** показывать другим пользователям текст объявления и контакт, который ты указал при размещении, чтобы соискатели могли с тобой связаться.',
              '**Чтобы собирать вакансии из открытых источников:** разбирать сообщения из публичных телеграм-чатов и каналов и показывать их в приложении как вакансии.',
              '**Чтобы понимать, откуда приходят люди:** считать, сколько человек пришло по каждой нашей ссылке, и не тратить силы на то, что не работает.',
            ],
          },
        ],
      },
      {
        heading: 'На каком основании мы это делаем',
        blocks: [
          {
            type: 'p',
            text: 'Мы обрабатываем данные о тебе как о пользователе приложения с твоего согласия. Начиная пользоваться приложением, ты даёшь такое согласие. Ты можешь отозвать его в любой момент (см. «Твои права» ниже).',
          },
          {
            type: 'p',
            text: 'Это касается данных, которые мы собираем непосредственно о тебе. Для вакансий, которые мы находим в открытых телеграм-чатах (контакты работодателей и рекрутёров), у нас другой подход — см. раздел «Вакансии из открытых телеграм-чатов» выше.',
          },
        ],
      },
      {
        heading: 'Сколько мы храним данные',
        blocks: [
          {
            type: 'p',
            text: 'Мы храним твои данные, пока ты пользуешься приложением. Если ты не заходишь в приложение 12 месяцев подряд, мы удаляем твои данные с сервера. Ты также можешь в любой момент попросить удалить данные раньше — см. «Твои права» ниже.',
          },
          {
            type: 'p',
            text: 'Технически это выглядит так: мы стираем всё, что указывает на тебя — номер аккаунта в Telegram, имя, ник, твои объявления, подписки, избранное, историю открытий. Остаётся обезличенная запись без имени и номера — только чтобы не сбились счётчики у людей, которые тебя приглашали. Если вернёшься — это будет новый аккаунт. Вместе с ней остаётся и пометка о том, по какой ссылке ты когда-то пришёл: она одинаковая у всех, кто пришёл оттуда же, узнать по ней тебя нельзя, а нужна она, чтобы не сбился счёт, сколько людей приводит каждая ссылка.',
          },
          {
            type: 'p',
            text: 'Отдельно: если ты кого-то пригласил, ты видишь только **итог** — сколько человек перешло по твоей ссылке и сколько баллов ты получил. Ты **не** видишь имена, username или другие данные приглашённых — только цифры.',
          },
        ],
      },
      {
        heading: 'Кто ещё видит твои данные (третьи лица и хостинг)',
        blocks: [
          { type: 'p', text: 'Часть данных обрабатывают наши технические подрядчики:' },
          {
            type: 'ul',
            items: [
              '**Telegram** — платформа, через которую работает приложение и бот.',
              '**Neon** — где хранится база данных приложения.',
              '**Vercel** — где работает само приложение.',
              '**DigitalOcean** — сервер, который собирает сообщения из открытых телеграм-чатов, прежде чем они попадают в приложение.',
              '**Anthropic** — сервис искусственного интеллекта, который помогает автоматически определять, является ли сообщение из чата вакансией, и сортировать объявления; при этом обрабатывается текст сообщений и объявлений, включая контакты, которые в нём есть.',
            ],
          },
          {
            type: 'p',
            text: 'Серверы этих сервисов могут физически находиться за пределами России, то есть твои данные могут передаваться в другие страны. Мы используем этих подрядчиков только для технической работы приложения, а не для передачи твоих данных кому-либо ещё.',
          },
        ],
      },
      {
        heading: 'Твои права',
        blocks: [
          { type: 'p', text: 'В любой момент ты можешь:' },
          {
            type: 'ul',
            items: [
              '**Узнать**, какие данные о тебе у нас есть.',
              '**Отозвать согласие** на обработку данных.',
              '**Попросить удалить** свои данные, включая контакт, который ты указал в объявлении.',
            ],
          },
          {
            type: 'p',
            text: 'Напиши нам: @korea_rabota_bot. Мы отвечаем и выполняем просьбу об удалении в течение 3 рабочих дней — без лишних вопросов.',
          },
          {
            type: 'p',
            text: 'Технически это выглядит так: мы стираем всё, что указывает на тебя — номер аккаунта в Telegram, имя, ник, твои объявления, подписки, избранное, историю открытий. Остаётся обезличенная запись без имени и номера — только чтобы не сбились счётчики у людей, которые тебя приглашали. Если вернёшься — это будет новый аккаунт. Вместе с ней остаётся и пометка о том, по какой ссылке ты когда-то пришёл: она одинаковая у всех, кто пришёл оттуда же, узнать по ней тебя нельзя, а нужна она, чтобы не сбился счёт, сколько людей приводит каждая ссылка.',
          },
          {
            type: 'p',
            text: 'Обрати внимание: если ты отзовёшь согласие или попросишь удалить данные, реферальная программа для тебя может перестать работать (например, начисление баллов остановится).',
          },
        ],
      },
      {
        heading: 'Если тебя пригласили в приложение',
        blocks: [
          {
            type: 'p',
            text: 'Если ты пришёл по чужой пригласительной ссылке: факт того, что ты начал пользоваться приложением и впервые открыл контакт работодателя, учитывается системой для начисления баллов пригласившему тебя человеку. Мы не передаём ему твоё имя, username или переписку — только сам факт, в виде счётчика.',
          },
        ],
      },
      {
        heading: 'Если случится утечка данных',
        blocks: [
          {
            type: 'p',
            text: 'Если мы обнаружим, что твои данные стали кому-то доступны без нашего ведома, — мы сообщим об этом пользователям, которых это касается, через приложение или бота, и постараемся сделать это как можно быстрее.',
          },
        ],
      },
      {
        heading: 'Изменения этой политики',
        blocks: [
          {
            type: 'p',
            text: 'Мы можем время от времени обновлять эту политику. О существенных изменениях постараемся сообщить в приложении или боте. Дата последнего обновления — в начале документа.',
          },
        ],
      },
    ],
  },
  en: {
    meta: 'Version: 1.1 · Effective date: 1 August 2026',
    intro:
      'We wrote this policy ourselves, in plain language, without hiring a professional lawyer — specifically so it would be easy to read and understand. If anything is unclear or raises questions, write to us: @korea_rabota_bot.',
    sections: [
      {
        heading: 'Who we are and how to reach us',
        blocks: [
          {
            type: 'p',
            text: 'This app (the "Korea Jobs" Mini App, bot @korea_rabota_bot) is run by a private individual, with no registered business entity. If you have questions about your data or this policy, write to us: @korea_rabota_bot.',
          },
        ],
      },
      {
        heading: 'What data we collect',
        blocks: [
          {
            type: 'p',
            text: 'We collect different data depending on how you use the app — whether you just browse job listings or post your own ad.',
          },
          {
            type: 'p',
            text: '**To make the app work, and to fairly award points for referrals, for every user we collect:**',
          },
          {
            type: 'ul',
            items: [
              "**Telegram ID** — your account's unique number, so we recognize you on your next visit.",
              '**Name and username** — as shown in Telegram (based on your privacy settings).',
              '**Interface language** — which language to show the app in.',
              '**Your filters and settings** — the cities and job types you want to get vacancies for, and your notification settings.',
              '**Who invited whom** — the referral chain, up to three levels: who invited you, who invited them, and one level beyond that.',
              "**Contact reveals** — the fact that you opened an employer's contact: both the very first time (that one earns points for whoever invited you) and every time after. We don't see or store your actual conversation with the employer.",
              '**Points** — your points balance and what it was earned for.',
              "**What you did in the app** — which jobs you saved to favorites, which contacts you opened and when, which notifications we sent you. We need this to show you your favorites, to avoid sending you the same thing twice, and to keep the daily limit on contact reveals.",
              '**Complaints and messages** — if you report a job listing, submit a request in the "Partners" section, or write to us in the bot, we store your message and the way to reach you, so we can look into it and reply. A message sent to the bot arrives in the personal Telegram chat of the person who runs the service.',
              "**Server technical logs** — IP address and the time of your requests to the app, same as any website or online service. This is needed to run and protect the servers; we don't separately analyze these logs or use them to make decisions about you.",
              "**Where you came from** — if you opened the app through one of our links (for example, from an ad or a flyer), we save a short tag for that link (for example, 'ads_ru1'). It is the same for everyone who came from there, it is written only on your first visit and never changes. We put nothing about you into it and never show it to anyone — not to other users, not to ad platforms: we need it to count how many people each link brings.",
            ],
          },
          { type: 'p', text: '**If you post your own job ad**' },
          {
            type: 'p',
            text: 'When you create an ad through "Post a job," you add to your data yourself:',
          },
          {
            type: 'ul',
            items: [
              '**Contact info** — phone number, KakaoTalk ID, WhatsApp, Telegram handle, or another way to reach you, which you provide so job seekers can contact you.',
              "**The ad's text** — title, job description, salary, schedule, housing and meal terms, city, and other fields you fill in on the posting form.",
            ],
          },
          {
            type: 'p',
            text: 'We do **not** ask you for documents, passport data, or bank details — neither to use the app, nor to post an ad. The exception is the contact info in your ad: you add it yourself, by your own choice, when you decide to post an ad.',
          },
        ],
      },
      {
        heading: 'Who sees the contact from your ad',
        blocks: [
          {
            type: 'p',
            text: 'When a job seeker taps "Show contact" on your ad, they see the contact info you provided when posting — a phone number, KakaoTalk, WhatsApp, Telegram handle, or another way to reach you. This happens by your own choice: you choose whether to post an ad with a contact at all, and which contact to give.',
          },
          {
            type: 'p',
            text: 'Any app user who opens that specific ad and taps "Show contact" can see it — we don\'t keep a separate, general list of contacts. We limit how many contact reveals a single user can do per day, to make bulk contact scraping harder, but we can\'t rule it out completely from a technical standpoint — keep that in mind when deciding what contact to give in your ad.',
          },
        ],
      },
      {
        heading: 'Jobs from open Telegram chats',
        blocks: [
          {
            type: 'p',
            text: 'Besides ads that users post through the app, we collect job listings from open (public) Telegram chats and channels, where employers and recruiters post job ads themselves.',
          },
          {
            type: 'p',
            text: "This means some of the contacts in the app belong to people who don't use our app and haven't given us consent directly — we take them from a message that was already posted, publicly, in an open chat anyone can join.",
          },
          {
            type: 'p',
            text: 'We automatically parse the text of these messages (including with the help of AI technology), strip out some obvious contacts from the ad\'s description text, and separately show the contact via "Show contact" if one could be parsed from the original message.',
          },
          {
            type: 'p',
            text: "If you are an employer, recruiter, or anyone else, and you see your own contact in the app from such a chat and want us to remove it — write to us at @korea_rabota_bot with a link to the ad or a description of it. We'll remove the contact from the app within 3 business days, no questions asked.",
          },
        ],
      },
      {
        heading: 'Why we use this data',
        blocks: [
          {
            type: 'ol',
            items: [
              '**To make the app work:** show you relevant jobs, send notifications about new jobs in your chosen cities, remember your settings.',
              '**To run the referral program fairly:** award points for referrals and show you your progress.',
              '**To publish your ads:** show other users the ad text and the contact you provided when posting, so job seekers can reach you.',
              '**To collect jobs from open sources:** parse messages from public Telegram chats and channels and show them in the app as job listings.',
              '**To understand where people come from:** count how many people arrived through each of our links, so we do not keep spending effort on what does not work.',
            ],
          },
        ],
      },
      {
        heading: 'Our legal basis',
        blocks: [
          {
            type: 'p',
            text: 'We process the data we collect about you as an app user based on your consent. By starting to use the app, you give us this consent. You can withdraw it at any time (see "Your rights" below).',
          },
          {
            type: 'p',
            text: 'This covers the data we collect directly about you. For job listings we find in open Telegram chats (employer and recruiter contacts), we take a different approach — see "Jobs from open Telegram chats" above.',
          },
        ],
      },
      {
        heading: 'How long we keep data',
        blocks: [
          {
            type: 'p',
            text: "We keep your data while you use the app. If you don't open the app for 12 months in a row, we delete your data from our servers. You can also ask us to delete your data sooner at any time — see \"Your rights\" below.",
          },
          {
            type: 'p',
            text: "Technically it works like this: we erase everything that points to you — your Telegram account number, your name, your username, your ads, your subscriptions, your favorites, the history of contacts you opened. What stays is an anonymized record with no name and no number — only so that the counters of the people who invited you don't break. If you come back, it will be a new account. Along with it we keep the tag for the link you once arrived through: it is the same for everyone who came from there, it cannot identify you, and we need it so the count of how many people each link brings stays correct.",
          },
          {
            type: 'p',
            text: "Separately: if you've invited someone, you only see the **total** — how many people used your link and how many points you earned. You do **not** see the names, usernames, or any other data of the people you invited — only numbers.",
          },
        ],
      },
      {
        heading: 'Who else sees your data (third parties and hosting)',
        blocks: [
          { type: 'p', text: 'Some data is processed by our technical providers:' },
          {
            type: 'ul',
            items: [
              '**Telegram** — the platform the app and bot run on.',
              "**Neon** — where the app's database is stored.",
              '**Vercel** — where the app itself runs.',
              '**DigitalOcean** — a server that collects messages from open Telegram chats before they reach the app.',
              '**Anthropic** — an AI service that helps us automatically tell whether a chat message is a job listing, and sort ads; this can involve processing message and ad text, including any contacts it contains.',
            ],
          },
          {
            type: 'p',
            text: "These providers' servers may be physically located outside Russia, meaning your data may be transferred to other countries. We use these providers only for the technical operation of the app, not to sell or share your data with anyone else.",
          },
        ],
      },
      {
        heading: 'Your rights',
        blocks: [
          { type: 'p', text: 'At any time, you can:' },
          {
            type: 'ul',
            items: [
              '**Find out** what data we hold about you.',
              '**Withdraw your consent** to processing.',
              '**Request deletion** of your data, including any contact you provided in an ad.',
            ],
          },
          {
            type: 'p',
            text: 'Write to us: @korea_rabota_bot. We respond to and act on deletion requests within 3 business days, no questions asked.',
          },
          {
            type: 'p',
            text: "Technically it works like this: we erase everything that points to you — your Telegram account number, your name, your username, your ads, your subscriptions, your favorites, the history of contacts you opened. What stays is an anonymized record with no name and no number — only so that the counters of the people who invited you don't break. If you come back, it will be a new account. Along with it we keep the tag for the link you once arrived through: it is the same for everyone who came from there, it cannot identify you, and we need it so the count of how many people each link brings stays correct.",
          },
          {
            type: 'p',
            text: 'Note: if you withdraw consent or request deletion, the referral program may stop working for you (for example, points may no longer accrue).',
          },
        ],
      },
      {
        heading: 'If you were invited to the app',
        blocks: [
          {
            type: 'p',
            text: "If you joined via someone else's invite link: the fact that you started using the app and opened an employer's contact for the first time is recorded by the system to award points to the person who invited you. We do not share your name, username, or messages with them — only the fact itself, as a counter.",
          },
        ],
      },
      {
        heading: "If there's a data breach",
        blocks: [
          {
            type: 'p',
            text: "If we discover that your data became accessible to someone without our knowledge, we'll notify the users affected through the app or the bot, and try to do so as quickly as possible.",
          },
        ],
      },
      {
        heading: 'Changes to this policy',
        blocks: [
          {
            type: 'p',
            text: "We may update this policy from time to time. We'll try to notify you of significant changes in the app or bot. The date of the latest update is shown at the top of this document.",
          },
        ],
      },
    ],
  },
};
