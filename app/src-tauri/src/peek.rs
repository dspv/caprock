//! The peek (macOS, off by default): when a session Caprock started begins
//! waiting on you — a permission prompt, a question, a plan — the menu bar
//! popover shows itself under the icon without taking focus, and goes away
//! on an answer, Escape, a click elsewhere or after a quiet spell untouched.
//!
//! This is the decision alone, without a window, so it is tested on every
//! OS: which session may peek, when, and how often. The page marks which
//! waiting rows may peek (`tray::Waiting::peek`: the Settings switch is on,
//! Caprock owns the session, a dialog waits); popover.rs shows and hides.

use std::collections::HashSet;
use std::time::{Duration, Instant};

/// After a peek is dismissed (Escape, a click elsewhere, the timeout), no
/// other peek for this long: one ignored is a "not now".
pub const QUIET: Duration = Duration::from_secs(60);
/// A peek nobody touches goes away after this.
pub const UNTOUCHED: Duration = Duration::from_secs(15);

/// What popover.rs should do with the window.
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Nothing,
    /// Show it as a peek for this session (or keep it up, now for this one).
    Show(String),
    /// Hide the peek: its session no longer waits and nothing else may peek.
    Hide,
}

/// What the shell knows besides the waiting list.
#[derive(Default, Clone, Copy)]
pub struct Ctx<'a> {
    /// The popover is open because the user opened it: never a peek over it.
    pub opened_by_user: bool,
    /// The session the main window shows while it is the frontmost window.
    pub front: Option<&'a str>,
}

#[derive(Default)]
pub struct Peeker {
    /// Sessions whose current waiting episode has had its one chance: it
    /// peeked, or was skipped (you were looking at it, the quiet minute, the
    /// popover was open). Forgotten when the session stops waiting, so the
    /// next time it waits is a new episode.
    seen: HashSet<String>,
    /// The session the peek on screen is for.
    showing: Option<String>,
    /// The user clicked into the peek: from then on it is an ordinary popover,
    /// which hides when it loses focus.
    touched: bool,
    quiet_until: Option<Instant>,
    /// Bumped on every peek, so a timer for an older one does nothing.
    generation: u64,
}

impl Peeker {
    /// The page sent a new waiting list; `eligible` holds the sessions that
    /// may peek, in the page's order (oldest first).
    pub fn update(&mut self, eligible: &[String], ctx: Ctx<'_>, now: Instant) -> Action {
        self.seen.retain(|id| eligible.contains(id));
        if let Some(cur) = &self.showing {
            if eligible.contains(cur) {
                // Anything else that starts waiting is listed in the panel
                // on screen: that is its peek.
                self.seen.extend(eligible.iter().cloned());
                return Action::Nothing;
            }
            // Answered, in the terminal or the window: on to the next, if any.
            self.showing = None;
            return match self.next(eligible, ctx, now) {
                Some(id) => Action::Show(id),
                None => Action::Hide,
            };
        }
        if ctx.opened_by_user {
            self.seen.extend(eligible.iter().cloned());
            return Action::Nothing;
        }
        match self.next(eligible, ctx, now) {
            Some(id) => Action::Show(id),
            None => Action::Nothing,
        }
    }

    fn next(&mut self, eligible: &[String], ctx: Ctx<'_>, now: Instant) -> Option<String> {
        let quiet = self.quiet_until.is_some_and(|t| now < t);
        for id in eligible {
            if !self.seen.insert(id.clone()) {
                continue;
            }
            if quiet || ctx.front == Some(id.as_str()) {
                continue;
            }
            self.showing = Some(id.clone());
            self.touched = false;
            self.generation += 1;
            return Some(id.clone());
        }
        None
    }

    /// Whether a peek is on screen.
    pub fn showing(&self) -> bool {
        self.showing.is_some()
    }

    /// The current peek's number, for its timer.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// The user clicked into the peek (it became the key window).
    pub fn touch(&mut self) {
        if self.showing.is_some() {
            self.touched = true;
        }
    }

    /// Whether the peek is still up and untouched, so a click elsewhere
    /// should take it away.
    pub fn untouched(&self) -> bool {
        self.showing.is_some() && !self.touched
    }

    /// The peek went away unanswered (Escape, a click elsewhere, the icon,
    /// the timeout): the quiet minute starts. False when no peek was up.
    pub fn dismiss(&mut self, now: Instant) -> bool {
        if self.showing.take().is_none() {
            return false;
        }
        self.touched = false;
        self.quiet_until = Some(now + QUIET);
        true
    }

    /// The peek went away because the user acted in it (Approve, Deny, Open):
    /// no quiet minute.
    pub fn answered(&mut self) {
        self.showing = None;
        self.touched = false;
    }

    /// The timer for peek `generation` ran out: true when that peek is still
    /// up and untouched and the pointer is not over it, so it is dismissed.
    pub fn expire(&mut self, generation: u64, pointer_over: bool, now: Instant) -> bool {
        if generation != self.generation || !self.untouched() || pointer_over {
            return false;
        }
        self.dismiss(now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    const NONE: Ctx<'static> = Ctx {
        opened_by_user: false,
        front: None,
    };

    #[test]
    fn a_session_that_starts_waiting_peeks_once_per_episode() {
        let mut p = Peeker::default();
        let t = Instant::now();
        assert_eq!(p.update(&ids(&["a"]), NONE, t), Action::Show("a".into()));
        // The same list again (another frame): no second peek.
        assert_eq!(p.update(&ids(&["a"]), NONE, t), Action::Nothing);
        p.answered();
        assert_eq!(p.update(&ids(&["a"]), NONE, t), Action::Nothing);
        // It stops waiting, then waits again: a new episode.
        assert_eq!(p.update(&[], NONE, t), Action::Nothing);
        assert_eq!(p.update(&ids(&["a"]), NONE, t), Action::Show("a".into()));
    }

    #[test]
    fn an_answer_elsewhere_hides_the_peek_or_moves_it_on() {
        let mut p = Peeker::default();
        let t = Instant::now();
        assert_eq!(p.update(&ids(&["a"]), NONE, t), Action::Show("a".into()));
        assert_eq!(p.update(&[], NONE, t), Action::Hide);
        assert!(!p.showing());

        let mut p = Peeker::default();
        assert_eq!(p.update(&ids(&["a"]), NONE, t), Action::Show("a".into()));
        // b waits while a's peek is up: listed in it, so no peek of its own...
        assert_eq!(p.update(&ids(&["a", "b"]), NONE, t), Action::Nothing);
        // ...and when a is answered, b has had its chance.
        assert_eq!(p.update(&ids(&["b"]), NONE, t), Action::Hide);
        // c starts waiting as a is answered: the peek moves to c.
        let mut p = Peeker::default();
        assert_eq!(p.update(&ids(&["a"]), NONE, t), Action::Show("a".into()));
        assert_eq!(p.update(&ids(&["c"]), NONE, t), Action::Show("c".into()));
    }

    #[test]
    fn a_dismiss_starts_a_quiet_minute() {
        let mut p = Peeker::default();
        let t = Instant::now();
        assert_eq!(p.update(&ids(&["a"]), NONE, t), Action::Show("a".into()));
        assert!(p.dismiss(t));
        assert!(!p.dismiss(t), "nothing left to dismiss");
        // b starts waiting inside the minute: no peek, and none later for
        // this episode either.
        let soon = t + Duration::from_secs(30);
        assert_eq!(p.update(&ids(&["a", "b"]), NONE, soon), Action::Nothing);
        let later = t + QUIET + Duration::from_secs(1);
        assert_eq!(p.update(&ids(&["a", "b"]), NONE, later), Action::Nothing);
        // c after the minute peeks.
        assert_eq!(
            p.update(&ids(&["a", "b", "c"]), NONE, later),
            Action::Show("c".into())
        );
    }

    #[test]
    fn an_answer_in_the_peek_starts_no_quiet_minute() {
        let mut p = Peeker::default();
        let t = Instant::now();
        assert_eq!(p.update(&ids(&["a"]), NONE, t), Action::Show("a".into()));
        p.answered();
        assert_eq!(p.update(&ids(&["b"]), NONE, t), Action::Show("b".into()));
    }

    #[test]
    fn never_over_the_session_you_are_looking_at_or_a_popover_you_opened() {
        let mut p = Peeker::default();
        let t = Instant::now();
        let front = Ctx {
            opened_by_user: false,
            front: Some("a"),
        };
        assert_eq!(p.update(&ids(&["a"]), front, t), Action::Nothing);
        // Looked at is seen: switching away later does not peek it.
        assert_eq!(p.update(&ids(&["a"]), NONE, t), Action::Nothing);
        // Another session still peeks while you look at a.
        assert_eq!(
            p.update(&ids(&["a", "b"]), front, t),
            Action::Show("b".into())
        );

        let mut p = Peeker::default();
        let open = Ctx {
            opened_by_user: true,
            front: None,
        };
        assert_eq!(p.update(&ids(&["a"]), open, t), Action::Nothing);
        assert_eq!(p.update(&ids(&["a"]), NONE, t), Action::Nothing);
    }

    #[test]
    fn the_timeout_dismisses_only_an_untouched_peek_not_under_the_pointer() {
        let mut p = Peeker::default();
        let t = Instant::now();
        assert_eq!(p.update(&ids(&["a"]), NONE, t), Action::Show("a".into()));
        let g = p.generation();
        assert!(!p.expire(g, true, t), "the pointer is over it");
        assert!(!p.expire(g + 1, false, t), "an older peek's timer");
        p.touch();
        assert!(!p.untouched());
        assert!(!p.expire(g, false, t), "clicked into: an ordinary popover");
        // A touched peek that loses focus is still a dismiss.
        assert!(p.dismiss(t));

        let mut p = Peeker::default();
        assert_eq!(p.update(&ids(&["a"]), NONE, t), Action::Show("a".into()));
        assert!(p.expire(p.generation(), false, t));
        assert!(!p.showing());
    }

    #[test]
    fn switched_off_nothing_peeks_and_a_peek_on_screen_goes() {
        let mut p = Peeker::default();
        let t = Instant::now();
        assert_eq!(p.update(&[], NONE, t), Action::Nothing);
        assert_eq!(p.update(&ids(&["a"]), NONE, t), Action::Show("a".into()));
        // The switch turned off: the page marks nothing as able to peek.
        assert_eq!(p.update(&[], NONE, t), Action::Hide);
    }
}
