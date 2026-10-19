# Demo script

## Introduction

“This workflow connects GitHub issue assignment requests with maintainer review in Discord. Contributors request an issue using `/assign-me`, and they receive the decision back on GitHub.”

## Approval

1. **Show the GitHub request.** “The contributor describes the work they want to take on and includes `/assign-me`. The bot acknowledges the request and sends it for review.”
2. **Show the pending Discord card.** “The maintainer can see the issue, the contributor's comment, and the requester. View request opens the original comment.”
3. **Select Assign, or show the completed card.** “Assign approves the request. The card updates to show who was assigned, and Discord confirms the action privately.”
4. **Show the GitHub outcome.** “GitHub records the assignment, and the bot tells the contributor that the request was approved.”

## Denial

1. **Show the second request and its pending Discord card.** “This request follows the same review process.”
2. **Select Dismiss, or show the completed card.** “Dismiss denies the assignment request. The Discord card updates to show that it was dismissed.”
3. **Show the GitHub denial comment.** “The bot tells the contributor that the request was denied and that they were not assigned through this request.”

## Closing

“Maintainers make the decision in Discord, while contributors can follow the request and its outcome on the GitHub issue.”
