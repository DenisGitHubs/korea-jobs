import type { LegalDocByLang } from './types';

/**
 * DRAFT Privacy Policy (RU + EN). Source: _docs/legal/privacy-policy.draft.md.
 * Placeholders `*[...]*` are kept visible on screen; the owner fills them later.
 * Do not treat as final legal text — pending owner + lawyer review.
 */
export const PRIVACY_POLICY: LegalDocByLang = {
  ru: {
    meta: 'Версия: черновик 0.1 · Дата вступления в силу: *[заполнить]*',
    draftNote:
      'ЧЕРНОВИК — для проверки владельцем и юристом. Не является юридическим заключением. Не публиковать без согласования.',
    sections: [
      {
        heading: 'Кто мы и как с нами связаться',
        blocks: [
          {
            type: 'p',
            text: 'Это приложение (мини-приложение «Корея — вакансии», бот @korea_rabota_bot) работает под управлением *[ФИО/статус оператора — заполнить владельцем, например «Иванов Иван Иванович, физическое лицо»]*. Если у вас есть вопросы о ваших данных — напишите нам: *[контакт оператора — заполнить]*.',
          },
        ],
      },
      {
        heading: 'Какие данные мы собираем',
        blocks: [
          {
            type: 'p',
            text: 'Чтобы приложение работало и чтобы честно начислять баллы за приглашения, мы собираем:',
          },
          {
            type: 'ul',
            items: [
              '**Telegram ID** — уникальный номер вашего аккаунта в Telegram, чтобы узнавать вас при следующем визите.',
              '**Имя и username** — как вас зовут в Telegram (согласно вашим настройкам приватности).',
              '**Язык интерфейса** — на каком языке показывать вам приложение.',
              '**Города, на которые вы подписались** — чтобы присылать вакансии из нужных вам городов.',
              '**Кто кого пригласил** — цепочка приглашений до трёх уровней: кто пригласил вас, кто пригласил того, кто пригласил вас, и ещё на один уровень выше.',
              '**Факт «активации»** — то, что вы впервые открыли контакт работодателя в приложении. Это само событие, а не переписка — саму переписку с работодателем мы не видим и не храним.',
              '**Баллы** — сколько у вас накоплено и за что начислено.',
            ],
          },
          {
            type: 'p',
            text: 'Мы **не** собираем вашу переписку с работодателями, не запрашиваем документы, паспортные данные или банковские реквизиты.',
          },
        ],
      },
      {
        heading: 'Зачем нам эти данные',
        blocks: [
          {
            type: 'ol',
            items: [
              '**Чтобы приложение работало:** показывать подходящие вакансии, присылать уведомления о новых вакансиях в выбранных городах, запоминать ваши настройки.',
              '**Чтобы честно вести реферальную программу:** начислять баллы за приглашения и показывать ваш прогресс.',
            ],
          },
        ],
      },
      {
        heading: 'На каком основании мы это делаем',
        blocks: [
          {
            type: 'p',
            text: 'Мы обрабатываем данные с вашего согласия. Начиная пользоваться приложением, вы даёте такое согласие. Вы можете отозвать его в любой момент (см. «Ваши права» ниже).',
          },
        ],
      },
      {
        heading: 'Сколько мы храним данные',
        blocks: [
          {
            type: 'p',
            text: 'Мы храним данные, пока вы пользуетесь приложением, и удаляем их по вашей просьбе или при длительной неактивности аккаунта *[срок — уточнить у владельца, например «12 месяцев»]*. Храним только то, что действительно нужно для работы приложения и программы баллов.',
          },
          {
            type: 'p',
            text: 'Отдельно: если вы кого-то пригласили, вы видите только **итог** — сколько человек перешло по вашей ссылке и сколько баллов вы получили. Вы **не** видите имена, username или другие данные приглашённых — только цифры.',
          },
        ],
      },
      {
        heading: 'Кто ещё видит ваши данные (третьи лица и хостинг)',
        blocks: [
          { type: 'p', text: 'Часть данных обрабатывают наши технические подрядчики:' },
          {
            type: 'ul',
            items: [
              '**Telegram** — платформа, через которую работает приложение и бот.',
              '**Neon** — где хранится база данных приложения.',
              '**Vercel** — где работает само приложение.',
            ],
          },
          {
            type: 'p',
            text: 'Серверы этих сервисов могут физически находиться за пределами России, то есть ваши данные могут передаваться в другие страны. Мы используем этих подрядчиков только для технической работы приложения, а не для передачи ваших данных кому-либо ещё.',
          },
        ],
      },
      {
        heading: 'Ваши права',
        blocks: [
          { type: 'p', text: 'Вы можете в любой момент:' },
          {
            type: 'ul',
            items: [
              '**Узнать**, какие данные о вас у нас есть.',
              '**Отозвать согласие** на обработку данных.',
              '**Попросить удалить** свои данные.',
            ],
          },
          {
            type: 'p',
            text: 'Напишите нам: *[контакт оператора — заполнить]*. Мы ответим и поможем в разумный срок.',
          },
          {
            type: 'p',
            text: 'Обратите внимание: при отзыве согласия или удалении данных реферальная программа для вас может перестать работать (например, начисление баллов остановится).',
          },
        ],
      },
      {
        heading: 'Если вас пригласили в приложение',
        blocks: [
          {
            type: 'p',
            text: 'Если вы пришли по чужой пригласительной ссылке: факт того, что вы начали пользоваться приложением и впервые открыли контакт работодателя, учитывается системой для начисления баллов пригласившему вас человеку. Мы не передаём ему ваше имя, username или переписку — только сам факт, в виде счётчика.',
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
    meta: 'Version: draft 0.1 · Effective date: *[to be filled in]*',
    draftNote:
      'DRAFT — for owner and lawyer review. This is not legal advice. Do not publish until reviewed.',
    sections: [
      {
        heading: 'Who we are and how to reach us',
        blocks: [
          {
            type: 'p',
            text: 'This app (the "Korea Jobs" Mini App, bot @korea_rabota_bot) is run by *[operator\'s name/status — owner to fill in, e.g. "Ivan Ivanov, private individual"]*. If you have questions about your data, write to us: *[operator contact — to be filled in]*.',
          },
        ],
      },
      {
        heading: 'What data we collect',
        blocks: [
          {
            type: 'p',
            text: 'To make the app work, and to fairly award points for referrals, we collect:',
          },
          {
            type: 'ul',
            items: [
              "**Telegram ID** — your account's unique number, so we recognize you on your next visit.",
              '**Name and username** — as shown in Telegram (based on your privacy settings).',
              '**Interface language** — which language to show the app in.',
              "**Cities you've subscribed to** — so we can send you jobs from the cities you care about.",
              '**Who invited whom** — the referral chain, up to three levels: who invited you, who invited them, and one level beyond that.',
              '**The fact of "activation"** — that you opened an employer\'s contact for the first time in the app. This is just the event itself, not the conversation — we don\'t see or store your chat with the employer.',
              '**Points** — your points balance and what it was earned for.',
            ],
          },
          {
            type: 'p',
            text: "We do **not** collect your conversations with employers, and we don't ask for documents, passport data, or bank details.",
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
            ],
          },
        ],
      },
      {
        heading: 'Our legal basis',
        blocks: [
          {
            type: 'p',
            text: 'We process your data based on your consent. By starting to use the app, you give us this consent. You can withdraw it at any time (see "Your rights" below).',
          },
        ],
      },
      {
        heading: 'How long we keep data',
        blocks: [
          {
            type: 'p',
            text: 'We keep data while you use the app, and delete it on request or after prolonged inactivity *[period — owner to confirm, e.g. "12 months"]*. We try to keep only what\'s actually needed to run the app and the points program.',
          },
          {
            type: 'p',
            text: "Separately: if you've invited someone, you only see the **total** — how many people used your link and how many points you earned. You do **not** see the names, usernames, or any other personal data of the people you invited — only numbers.",
          },
        ],
      },
      {
        heading: 'Who else sees your data (third parties and hosting)',
        blocks: [
          { type: 'p', text: 'To run the app, some data is processed by our technical providers:' },
          {
            type: 'ul',
            items: [
              '**Telegram** — the platform the app and bot run on.',
              "**Neon** — where the app's database is stored.",
              '**Vercel** — where the app itself runs.',
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
              '**Request deletion** of your data.',
            ],
          },
          {
            type: 'p',
            text: "Write to us: *[operator contact — to be filled in]*. We'll respond and help within a reasonable time.",
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
