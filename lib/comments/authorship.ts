/**
 * Who may change a comment.
 *
 * Its author, and nobody else. Separated from the action so the rule can be
 * read and tested on its own — the action around it is a database call and a
 * session lookup, and neither of those is the part worth being sure about.
 *
 * A comment whose author has since been removed from the team belongs to
 * nobody. Treating that as "anyone may edit it" would make removing a colleague
 * a way of opening up everything they ever wrote, so it is closed instead.
 *
 * Resolving is deliberately not covered here. That says whether the work has
 * been done, not what the note says, and anyone reviewing may say it.
 */
export function canModifyComment(
  comment: { authorId: string | null },
  userId: string,
): boolean {
  return comment.authorId !== null && comment.authorId === userId;
}
