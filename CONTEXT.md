# SRS learning vocabulary

SRS helps a learner remember material through lessons, scheduled recall, and optional extra practice. A course can cover Japanese, coursework, or another subject using the same learning concepts.

## Content

**Course**: A collection of related learning material with its own study settings and progression.
_Avoid_: Deck, when referring to the app's course rather than an imported Anki deck.

**Item type**: The definition of the fields and card templates shared by a kind of learning item.

**Field**: A named part of an item's content, such as its reading, meaning, image, or example sentences.

**Item**: One learning concept and its field values, accepted-answer customizations, notes, and prerequisites. An item can produce several cards.
_Avoid_: Card, when referring to all the content of the concept.

**Card template**: The definition of what an item asks the learner to recall, what it shows, and how the answer is judged.

**Card**: One recall task generated from an item and a card template, with its own study state and review schedule.

**Cloze sentence**: An example sentence containing a marked blank and its accepted answer, optionally accompanied by a translation.

## Study

**Lesson**: The introduction and initial quiz of an item's untaught cards before scheduled reviews begin.

**Review**: A scheduled recall attempt whose outcome changes a card's study schedule.
_Avoid_: Draft review, when referring to an SRS review.

**Study session**: One run of lessons, reviews, or extra practice.

**Stage**: A position on a course's interval ladder that determines when a card is next reviewed.

**Pass**: The milestone used to satisfy prerequisite or level progression requirements. Passing does not necessarily retire a card.

**Burn**: Retirement from ordinary scheduled reviews after reaching the ladder's final milestone.

**Prerequisite**: Another item that must pass before a dependent item can unlock.

**Level**: An ordered group of items used to pace course progression.

**Ghost**: A temporary extra-practice copy of a missed card, with its own short schedule. Its reviews do not advance the parent item's prerequisites or course level.

**Cram**: Optional extra practice that does not change ordinary SRS progress.

## Planned courses and intake

**Course plan**: An ordered outline of a course's units, source material, and release rules.

**Unit**: A planned section of a course corresponding to a level.

**Release mode**: The rule opening a planned unit: learner progress, a scheduled date, or manual release.

**Proposal**: A candidate item waiting for acceptance, correction, or rejection. It is not yet a learned course item.

**Draft review queue**: The proposals awaiting the learner's content decision.
_Avoid_: Review queue, without qualification when it could mean scheduled SRS reviews.

**Capture**: A quick note saved for later conversion into structured learning content.

**Packet**: Content or proposals transferred into the app from a file, AI generation, or an external assistant.

**Course package**: A portable course-content export, distinct from a personal progress backup.

**Backup**: A saved copy of the learner's persisted content and study history for recovery. Device credentials are separate from portable study data.
