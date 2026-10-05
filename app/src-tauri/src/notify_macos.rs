//! macOS notifications with buttons, through UNUserNotificationCenter
//! (`notify.rs` decides what they say and answers them). Works in an
//! ad-hoc-signed bundle: the system asks the user once, on the first
//! notification. Outside a `.app` (`cargo run`), or where the system refuses
//! the app outright (a bundle LaunchServices has not registered at its path,
//! such as one under a temporary directory), it hands the notification to the
//! official plugin, which shows it without buttons.

use crate::notify::{Buttons, Note, Origin, Reply};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread};
use objc2_foundation::{NSArray, NSBundle, NSDictionary, NSError, NSSet, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNErrorCode, UNErrorDomain, UNMutableNotificationContent,
    UNNotification, UNNotificationAction, UNNotificationActionOptions, UNNotificationCategory,
    UNNotificationCategoryOptions, UNNotificationDefaultActionIdentifier,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use std::sync::OnceLock;
use tauri::{AppHandle, Runtime};

const APPROVE: &str = "dev.caprock.approve";
const REVIEW: &str = "dev.caprock.review";
const SESSION: &str = "session_id";
const PROMPT: &str = "prompt_id";
const TITLE: &str = "title";

struct Hooks {
    reply: Box<dyn Fn(Reply, Origin) + Send + Sync>,
    fallback: Box<dyn Fn(&Note) + Send + Sync>,
}

static HOOKS: OnceLock<Hooks> = OnceLock::new();

define_class!(
    // SAFETY: NSObject has no subclassing requirements; no Drop.
    #[unsafe(super(NSObject))]
    #[name = "CaprockNotificationDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        /// Shown even while the app is in front: the page has already decided
        /// the reader is not looking at that session.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            handler
                .call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            handler: &block2::DynBlock<dyn Fn()>,
        ) {
            received(response);
            handler.call(());
        }
    }
);

/// Takes the notification center when running from an app bundle: the
/// delegate (before launching finishes, so a click that launched the app is
/// delivered) and the two button sets.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let bundle = NSBundle::mainBundle();
    if bundle.bundleIdentifier().is_none() || !bundle.bundlePath().to_string().ends_with(".app") {
        return; // UNUserNotificationCenter raises outside a bundle
    }
    let (a, b) = (app.clone(), app.clone());
    let hooks = Hooks {
        reply: Box::new(move |r, o| crate::notify::respond(&a, r, o)),
        fallback: Box::new(move |n| {
            let _ = crate::notify::plain(&b, &n.title, &n.body);
        }),
    };
    if HOOKS.set(hooks).is_err() {
        return;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(), init] };
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // The center holds its delegate weakly; this one lives as long as the app.
    std::mem::forget(delegate);
    let action = |id: &str, title: &str, options| {
        UNNotificationAction::actionWithIdentifier_title_options(
            &NSString::from_str(id),
            &NSString::from_str(title),
            options,
        )
    };
    let category = |id: &str, actions: &[&UNNotificationAction]| {
        UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
            &NSString::from_str(id),
            &NSArray::from_slice(actions),
            &NSArray::new(),
            UNNotificationCategoryOptions::empty(),
        )
    };
    let approve = action(
        "allow",
        "Approve",
        UNNotificationActionOptions::AuthenticationRequired,
    );
    let deny = action("deny", "Deny", UNNotificationActionOptions::empty());
    let open = action(
        "open",
        "Open in Caprock",
        UNNotificationActionOptions::Foreground,
    );
    center.setNotificationCategories(&NSSet::from_slice(&[
        &*category(APPROVE, &[&approve, &deny]),
        &*category(REVIEW, &[&open, &deny]),
    ]));
}

/// Shows a notification, asking the user's permission the first time.
/// Hands it back when this center is not in use.
pub fn show(note: Note) -> Option<Note> {
    if HOOKS.get().is_none() {
        return Some(note);
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let done = RcBlock::new(move |granted: Bool, err: *mut NSError| {
        if granted.as_bool() {
            add(&note);
        } else if is_not_allowed(err) {
            if let Some(h) = HOOKS.get() {
                (h.fallback)(&note);
            }
        }
        // Otherwise the user said no: nothing is shown, as they asked.
    });
    center.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert, &done);
    None
}

/// The system refusing this app, as opposed to the user saying no.
fn is_not_allowed(err: *mut NSError) -> bool {
    // SAFETY: the completion handler's error is nil or a valid NSError.
    let Some(err) = (unsafe { err.as_ref() }) else {
        return false;
    };
    let domain = unsafe { UNErrorDomain }.is_some_and(|d| *err.domain() == *d);
    if domain && err.code() == UNErrorCode::NotificationsNotAllowed.0 {
        eprintln!("caprock-app: the system refuses notifications for this app: {err:?}");
        return true;
    }
    false
}

fn add(note: &Note) {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(&note.title));
    content.setBody(&NSString::from_str(&note.body));
    if let Some(s) = &note.session_id {
        content.setThreadIdentifier(&NSString::from_str(s));
    }
    match note.buttons {
        Buttons::ApproveDeny => content.setCategoryIdentifier(&NSString::from_str(APPROVE)),
        Buttons::OpenDeny => content.setCategoryIdentifier(&NSString::from_str(REVIEW)),
        Buttons::None => {}
    }
    let mut keys = vec![NSString::from_str(TITLE)];
    let mut values = vec![NSString::from_str(&note.title)];
    for (k, v) in [(SESSION, &note.session_id), (PROMPT, &note.prompt_id)] {
        if let Some(v) = v {
            keys.push(NSString::from_str(k));
            values.push(NSString::from_str(v));
        }
    }
    let keys: Vec<&NSString> = keys.iter().map(|k| &**k).collect();
    let values: Vec<&NSString> = values.iter().map(|v| &**v).collect();
    let info = NSDictionary::from_slices(&keys, &values);
    // SAFETY: strings only, which a notification's userInfo may hold.
    unsafe { content.setUserInfo(info.cast_unchecked()) };
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(&note.id),
        &content,
        None,
    );
    let done = RcBlock::new(|err: *mut NSError| {
        // SAFETY: nil or a valid NSError.
        if let Some(err) = unsafe { err.as_ref() } {
            eprintln!("caprock-app: notification not shown: {err:?}");
        }
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .addNotificationRequest_withCompletionHandler(&request, Some(&done));
}

fn received(response: &UNNotificationResponse) {
    let Some(hooks) = HOOKS.get() else {
        return;
    };
    let action = response.actionIdentifier();
    let reply = match action.to_string().as_str() {
        "allow" => Reply::Allow,
        "deny" => Reply::Deny,
        "open" => Reply::Open,
        _ if &*action == unsafe { UNNotificationDefaultActionIdentifier } => Reply::Open,
        _ => return, // dismissed
    };
    let info = response.notification().request().content().userInfo();
    let get = |k: &str| -> Option<String> {
        let v = info.objectForKey(&NSString::from_str(k))?;
        v.downcast::<NSString>().ok().map(|s| s.to_string())
    };
    let origin = Origin {
        session_id: get(SESSION),
        prompt_id: get(PROMPT),
        title: get(TITLE).unwrap_or_default(),
    };
    (hooks.reply)(reply, origin);
}
