import type { LegalDocByLang } from './types';

/**
 * DRAFT Referral Program Rules (RU + EN). Source: _docs/legal/referral-rules.draft.md.
 * Placeholders `*[...]*` are kept visible on screen; the owner fills them later.
 * Do not treat as final legal text — pending owner + lawyer review.
 */
export const REFERRAL_RULES: LegalDocByLang = {
  ru: {
    meta: 'Версия: черновик 0.1 · Дата вступления в силу: *[заполнить]* · Применимое право: законодательство РФ *[уточнить у владельца/юриста]* · Язык: программа ведётся на русском и английском, при расхождении текстов приоритет имеет *[уточнить — вероятно русский]*.',
    draftNote:
      'ЧЕРНОВИК — для проверки владельцем и юристом. Не является юридическим заключением и не публичной офертой.',
    sections: [
      {
        heading: '1. Кто проводит программу',
        blocks: [
          {
            type: 'p',
            text: 'Организатор — *[ФИО/статус владельца — заполнить, например «Иванов Иван Иванович, физическое лицо»]*, оператор приложения «Корея — вакансии» и бота @korea_rabota_bot. По вопросам программы: *[контакт оператора — заполнить]*.',
          },
        ],
      },
      {
        heading: '2. Что такое баллы',
        blocks: [
          {
            type: 'p',
            text: 'Баллы — это внутренние условные единицы приложения. Так мы говорим «спасибо за развитие сообщества» тем, кто приглашает знакомых.',
          },
          { type: 'p', text: 'Чем баллы **не являются**:' },
          {
            type: 'ul',
            items: [
              'это не деньги и не электронные денежные средства;',
              'у баллов нет номинальной (денежной) стоимости;',
              'баллы нельзя вывести, обменять на деньги или на что-либо ценное;',
              'баллы нельзя передать, подарить или продать другому пользователю — они привязаны только к вашему аккаунту.',
            ],
          },
        ],
      },
      {
        heading: '3. Как начисляются баллы',
        blocks: [
          {
            type: 'p',
            text: 'Баллы начисляются, когда приглашённый вами человек совершает целевое действие — впервые открывает контакт работодателя в приложении.',
          },
          {
            type: 'p',
            text: 'Баллы могут начисляться не только за тех, кого вы пригласили напрямую, но и за цепочку из приглашённых ими людей — до трёх уровней вглубь.',
          },
          { type: 'p', text: 'Уточнения:' },
          {
            type: 'ul',
            items: [
              'Точные ставки (сколько баллов и за какой уровень цепочки) могут время от времени меняться — актуальные цифры всегда показаны в приложении.',
              'Начисление может происходить не мгновенно — иногда нужно время, чтобы подтвердить, что действие настоящее.',
              'Мы вправе устанавливать лимиты (например, на количество баллов в день или засчитываемых приглашений).',
              'При признаках накрутки или нарушения правил мы вправе не начислить баллы или аннулировать уже начисленные — без каких-либо компенсаций.',
            ],
          },
        ],
      },
      {
        heading: '4. Что дают баллы сейчас и в будущем',
        blocks: [
          {
            type: 'p',
            text: 'Сейчас баллы можно только накапливать — они отражают ваш вклад в развитие сообщества.',
          },
          {
            type: 'p',
            text: 'В будущем мы планируем ввести дополнительные внутренние бонусы за накопленные баллы (например, *[примеры — уточнить у владельца]*). Это предварительные планы: мы не гарантируем их появление, не называем сроков и вправе изменить или отменить их.',
          },
        ],
      },
      {
        heading: '5. Мы можем менять или закрывать программу',
        blocks: [
          {
            type: 'p',
            text: 'Организатор вправе в любой момент, без предварительного уведомления и объяснения причин:',
          },
          {
            type: 'ul',
            items: [
              'изменить правила, ставки начисления, лимиты и условия программы;',
              'приостановить или полностью закрыть программу;',
              'аннулировать баллы, полученные с нарушением правил.',
            ],
          },
          { type: 'p', text: 'Такие изменения не дают участникам права на компенсацию.' },
        ],
      },
      {
        heading: '6. Программа бесплатна и это не заработок',
        blocks: [
          { type: 'p', text: 'Участие в программе бесплатное и не требует вложений или покупок.' },
          {
            type: 'p',
            text: 'Баллы — это не заработок, не доход и не инвестиция. Участвуя в программе, вы не заключаете с организатором сделку об оплате труда, инвестировании или получении дохода.',
          },
          {
            type: 'p',
            text: 'Эти правила не являются публичной офертой в смысле статьи 437 Гражданского кодекса РФ и не публичным обещанием награды в смысле статьи 1055 ГК РФ — организатор не берёт на себя обязательство выплатить деньги или передать имущество за приглашения.',
          },
        ],
      },
      {
        heading: '7. Что запрещено',
        blocks: [
          { type: 'p', text: 'Нельзя:' },
          {
            type: 'ul',
            items: [
              'накручивать приглашения (боты, фейковые или купленные аккаунты);',
              'приглашать самого себя через другие аккаунты;',
              'рассылать спам ради приглашений;',
              'любым иным способом обманывать систему подсчёта.',
            ],
          },
          {
            type: 'p',
            text: 'При обнаружении — мы вправе аннулировать баллы, ограничить или заблокировать участие в программе (при серьёзных нарушениях — доступ к приложению).',
          },
        ],
      },
      {
        heading: '8. Персональные данные',
        blocks: [
          {
            type: 'p',
            text: 'Работа программы связана с обработкой ваших персональных данных (кто кого пригласил, факт активации). Подробности — в нашей Политике конфиденциальности [ссылка]. Участвуя в программе, вы соглашаетесь с этой политикой.',
          },
        ],
      },
      {
        heading: '9. Ответственность за действия работодателей и третьих лиц',
        blocks: [
          {
            type: 'p',
            text: 'Организатор не отвечает за действия, вакансии и обещания работодателей и других третьих лиц, размещённые или упомянутые в приложении — см. общий дисклеймер приложения [ссылка/раздел].',
          },
        ],
      },
      {
        heading: '10. Территория, язык и применимое право',
        blocks: [
          {
            type: 'p',
            text: 'Программа доступна пользователям приложения независимо от страны *[уточнить у владельца, нужно ли ограничение]*. Правила ведутся на русском и английском. К отношениям по программе применяется законодательство РФ *[уточнить у юриста с учётом пользователей вне РФ]*.',
          },
          {
            type: 'p',
            text: 'Дата вступления в силу текущей редакции: *[заполнить]*. Версия: *[заполнить]*. Об изменениях сообщаем в приложении и/или боте; продолжение использования программы после изменений означает согласие с новой редакцией.',
          },
        ],
      },
      {
        heading: '11. Возраст участников',
        blocks: [
          {
            type: 'p',
            text: 'Участвовать может пользователь, достигший совершеннолетия по законодательству страны своего проживания (по умолчанию — 18 лет). *[Уточнить у владельца/юриста итоговую формулировку и нужен ли отдельный чек-бокс подтверждения возраста.]*',
          },
        ],
      },
    ],
  },
  en: {
    meta: 'Version: draft 0.1 · Effective date: *[to be filled in]* · Governing law: laws of the Russian Federation *[to confirm with owner/lawyer]* · Language: the program runs in Russian and English; in case of discrepancy, *[likely Russian]* prevails.',
    draftNote:
      'DRAFT — for owner and lawyer review. This is not legal advice and not a public offer.',
    sections: [
      {
        heading: '1. Who runs the program',
        blocks: [
          {
            type: 'p',
            text: 'The organizer is *[owner\'s name/status — to be filled in, e.g. "Ivan Ivanov, private individual"]*, operator of the "Korea Jobs" app and the @korea_rabota_bot. For questions about the program: *[operator contact — to be filled in]*.',
          },
        ],
      },
      {
        heading: '2. What points are',
        blocks: [
          {
            type: 'p',
            text: 'Points are internal, app-specific units. They\'re our way of saying "thank you for helping the community grow" when you invite people you know.',
          },
          { type: 'p', text: 'What points are **not**:' },
          {
            type: 'ul',
            items: [
              'they are not money or electronic money;',
              'points have no face (monetary) value;',
              'points cannot be withdrawn, exchanged for money, or exchanged for anything of value;',
              'points cannot be transferred, gifted, or sold to another user — they are tied only to your own account.',
            ],
          },
        ],
      },
      {
        heading: '3. How points are earned',
        blocks: [
          {
            type: 'p',
            text: "Points are awarded when someone you invited completes a target action — opening an employer's contact in the app for the first time.",
          },
          {
            type: 'p',
            text: 'Points may be awarded not only for people you invited directly, but also for the chain of people they invite — up to three levels deep.',
          },
          { type: 'p', text: 'Notes:' },
          {
            type: 'ul',
            items: [
              'Exact rates (how many points, for which level of the chain) may change from time to time — current numbers are always shown in the app.',
              'Crediting may not be instant — sometimes it takes time to confirm an action is genuine.',
              'We may set limits (for example, on points per day, or on how many invites count).',
              'If we detect signs of manipulation or rule violations, we may withhold points or cancel (annul) points already credited — without any compensation.',
            ],
          },
        ],
      },
      {
        heading: '4. What points do now, and in the future',
        blocks: [
          {
            type: 'p',
            text: 'Right now, points can only be accumulated — they reflect your contribution to growing the community.',
          },
          {
            type: 'p',
            text: 'In the future, we plan to introduce additional in-app bonuses redeemable with accumulated points (for example, *[examples — owner to confirm]*). These are preliminary plans: we do not guarantee these bonuses will appear, we set no timeline, and we may change or cancel these plans at any time.',
          },
        ],
      },
      {
        heading: '5. We may change or close the program',
        blocks: [
          {
            type: 'p',
            text: 'The organizer may, at any time, without prior notice and without explanation:',
          },
          {
            type: 'ul',
            items: [
              "change the program's rules, point rates, limits, and conditions;",
              'suspend or fully close the program;',
              'cancel points obtained in violation of the rules.',
            ],
          },
          { type: 'p', text: 'Such changes do not entitle participants to any compensation.' },
        ],
      },
      {
        heading: '6. The program is free and is not a form of earnings',
        blocks: [
          { type: 'p', text: 'Participation is free and requires no investment or purchase.' },
          {
            type: 'p',
            text: 'Points are not earnings, income, or an investment. By taking part in the program, you are not entering into any agreement with the organizer for paid work, investment, or income.',
          },
          {
            type: 'p',
            text: 'These rules do not constitute a public offer under Article 437 of the Russian Civil Code, nor a public promise of reward under Article 1055 of the Russian Civil Code — the organizer takes on no obligation to pay money or transfer property in exchange for referrals.',
          },
        ],
      },
      {
        heading: '7. What is not allowed',
        blocks: [
          { type: 'p', text: 'You may not:' },
          {
            type: 'ul',
            items: [
              'artificially inflate referrals (bots, fake or purchased accounts);',
              'invite "yourself" through other accounts;',
              'send spam in order to gain invites;',
              'otherwise attempt to deceive the counting system.',
            ],
          },
          {
            type: 'p',
            text: 'If we detect this, we may cancel points, restrict or block your participation in the program (and, for serious violations, your access to the app).',
          },
        ],
      },
      {
        heading: '8. Personal data',
        blocks: [
          {
            type: 'p',
            text: 'Running the program involves processing your personal data (who invited whom, the fact of activation). See our Privacy Policy [link] for details. By participating in the program, you agree to that policy.',
          },
        ],
      },
      {
        heading: '9. Liability for employers and third parties',
        blocks: [
          {
            type: 'p',
            text: "The organizer is not responsible for the actions, job postings, or promises of employers and other third parties listed or mentioned in the app — see the app's general disclaimer [link/section].",
          },
        ],
      },
      {
        heading: '10. Territory, language, and governing law',
        blocks: [
          {
            type: 'p',
            text: 'The program is available to app users regardless of country *[owner to confirm whether a restriction is needed]*. Rules are maintained in Russian and English. Relations under the program are governed by the laws of the Russian Federation *[to confirm with a lawyer, given users outside Russia]*.',
          },
          {
            type: 'p',
            text: 'Effective date of the current version: *[to be filled in]*. Version: *[to be filled in]*. We announce rule changes in the app and/or bot; continued use of the program after changes means acceptance of the new version.',
          },
        ],
      },
      {
        heading: '11. Age of participants',
        blocks: [
          {
            type: 'p',
            text: 'Participation is open to users who have reached the age of majority under the laws of their country of residence (default: 18 years old). *[Owner/lawyer to confirm final wording and whether a separate age-confirmation checkbox is needed.]*',
          },
        ],
      },
    ],
  },
};
