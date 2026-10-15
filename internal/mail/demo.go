package mail

import (
	"context"
	"net"
	"strconv"
	"time"

	"github.com/emersion/go-imap/v2"

	"github.com/dspv/caprock/internal/mail/fakemail"
	store "github.com/dspv/caprock/internal/mail/mailstore"
	"github.com/dspv/caprock/internal/mail/secrets"
)

// seedDemo starts two fake mail servers, fills them with sample mail and adds
// them as accounts, so the client can be tried (and screenshotted) offline.
func seedDemo(st *store.Store, sec secrets.Store) (func(), error) {
	now := time.Now()
	ago := func(d time.Duration) time.Time { return now.Add(-d) }
	type seed struct {
		folder string
		msg    fakemail.Msg
		seen   bool
	}
	work := []seed{
		{"INBOX", fakemail.Msg{From: "Maya Lindqvist <maya@northwind.io>", Subject: "Q4 budget — need your numbers by Friday",
			Body: "Hi,\n\nFinance closes the Q4 budget on Friday. Could you send me the infrastructure line items (hosting, CI, licences) by Thursday evening?\n\nA rough range is fine for anything not yet invoiced.\n\nThanks,\nMaya", Date: ago(25 * time.Minute), MessageID: "q4@northwind.io"}, false},
		{"INBOX", fakemail.Msg{From: "GitHub <noreply@github.com>", Subject: "[northwind/api] Pull request #482 merged",
			Body: "Merged #482 into main: retry webhook deliveries with backoff.\n\n3 files changed, 118 insertions(+), 24 deletions(-)", Date: ago(48 * time.Minute)}, false},
		{"INBOX", fakemail.Msg{From: "Tomás Rivera <tomas@acme-logistics.com>", Subject: "Contract renewal — signed copy",
			Body: "Hello,\n\nPlease find the countersigned renewal attached. The new term starts on the 1st.\n\nBest regards,\nTomás", Attach: "Renewal-2027-signed.pdf", Date: ago(2 * time.Hour), MessageID: "renewal@acme"}, false},
		{"INBOX", fakemail.Msg{From: "Priya Natarajan <priya@northwind.io>", Subject: "Offsite agenda draft",
			Body: "Team,\n\nFirst draft of the offsite agenda:\n\n- Day 1: roadmap review, customer panel\n- Day 2: architecture deep dive, hiring plan\n\nComments welcome before Wednesday.\n\nPriya", Date: ago(5 * time.Hour), MessageID: "offsite@northwind.io"}, true},
		{"INBOX", fakemail.Msg{From: "Jonas Weber <jonas@northwind.io>", Subject: "Re: Offsite agenda draft",
			Body: "Could we move the hiring plan to day 1? Half of the leads fly out on day 2.\n\nJonas\n\n> First draft of the offsite agenda", Date: ago(4 * time.Hour), MessageID: "offsite-2@northwind.io", InReplyTo: "offsite@northwind.io"}, false},
		{"INBOX", fakemail.Msg{From: "Stripe <receipts@stripe.com>", Subject: "Your receipt from Northwind Cloud",
			Body: "Receipt #1043-2210\nAmount paid: $2,140.00\nDate: today", HTML: `<div style="font-family:system-ui;max-width:520px;margin:0 auto"><h2 style="color:#635bff">Receipt from Northwind Cloud</h2><p>Amount paid <b>$2,140.00</b></p><table style="width:100%;border-collapse:collapse"><tr><td style="padding:6px 0;border-bottom:1px solid #eee">Compute (Oct)</td><td style="text-align:right">$1,720.00</td></tr><tr><td style="padding:6px 0;border-bottom:1px solid #eee">Storage</td><td style="text-align:right">$420.00</td></tr></table><p style="color:#888;font-size:12px">Receipt #1043-2210</p><img src="https://tracker.example.com/open.gif" width="1" height="1"></div>`, Date: ago(26 * time.Hour)}, true},
		{"INBOX", fakemail.Msg{From: "Lena Novak <lena@designhaus.studio>", Subject: "Brand refresh — first concepts",
			Body: "Hi! Three directions for the refresh are in the shared folder. My favourite is B, the calmer one. Can we walk through them on a call this week?\n\nLena", Date: ago(30 * time.Hour), MessageID: "brand@designhaus"}, true},
		{"INBOX", fakemail.Msg{From: "Security <security@northwind.io>", Subject: "New sign-in from Safari on macOS",
			Body: "A new sign-in to your account was detected from Safari on macOS in Lisbon, Portugal. If this was you, no action is needed.", Date: ago(52 * time.Hour)}, true},
		{"Sent", fakemail.Msg{From: "Alex Morgan <alex@northwind.io>", To: "Lena Novak <lena@designhaus.studio>", Subject: "Re: Brand refresh — first concepts",
			Body: "B is my favourite too. Thursday 3pm works.\n\nAlex", Date: ago(29 * time.Hour), InReplyTo: "brand@designhaus"}, true},
		{"Archive", fakemail.Msg{From: "Maya Lindqvist <maya@northwind.io>", Subject: "Q3 budget wrap-up",
			Body: "Q3 closed 4% under plan. Thanks everyone.", Date: ago(40 * 24 * time.Hour)}, true},
	}
	personal := []seed{
		{"INBOX", fakemail.Msg{From: "Sofia <sofia.m@icloud.com>", Subject: "Dinner Saturday?",
			Body: "We're thinking the new Georgian place at 8. In? 🍷", Date: ago(70 * time.Minute)}, false},
		{"INBOX", fakemail.Msg{From: "TAP Air Portugal <noreply@flytap.com>", Subject: "Your booking is confirmed: LIS → BER",
			Body: "Booking reference K7Q2XP\nDeparture 14 Nov, 07:25 from Lisbon (LIS)\nArrival 11:40 Berlin (BER)", Date: ago(3 * time.Hour)}, false},
		{"INBOX", fakemail.Msg{From: "Landlord — R. Costa <rcosta@gmail.com>", Subject: "Boiler service next week",
			Body: "Hello, the technician will come on Tuesday between 9 and 12. Will someone be home?\n\nRui", Date: ago(20 * time.Hour)}, true},
		{"INBOX", fakemail.Msg{From: "Hacker Newsletter <kale@hackernewsletter.com>", Subject: "Hacker Newsletter #712",
			Body: "This week: local-first software, SQLite in production, and why your mail client is slow.", Date: ago(60 * time.Hour)}, true},
		{"INBOX", fakemail.Msg{From: "ShopMart Deals <deals@shopmart-offers.biz>", Subject: "40% off everything — this weekend only",
			Body: "Our biggest sale of the season starts now. Use code WEEKEND40 at checkout. Unsubscribe any time.", Date: ago(9 * time.Hour)}, false},
		{"INBOX", fakemail.Msg{From: "Mailbox Support <alerts@mailbox-verify-center.info>", Subject: "Action required: your mailbox will be closed",
			Body: "We could not verify your mailbox. Sign in within 24 hours at the link below or your messages will be deleted.", Date: ago(14 * time.Hour)}, false},
	}
	var servers []*fakemail.Server
	add := func(name, email string, seeds []seed) error {
		srv, err := fakemail.Start(email, "demo")
		if err != nil {
			return err
		}
		servers = append(servers, srv)
		for _, s := range seeds {
			if s.msg.To == "" {
				s.msg.To = name + " <" + email + ">"
			}
			var fl []imap.Flag
			if s.seen {
				fl = append(fl, imap.FlagSeen)
			}
			if err := srv.Deliver(s.folder, s.msg.Raw(), fl...); err != nil {
				return err
			}
		}
		ih, ip, _ := net.SplitHostPort(srv.IMAPAddr)
		sh, sp, _ := net.SplitHostPort(srv.SMTPAddr)
		ipn, _ := strconv.Atoi(ip)
		spn, _ := strconv.Atoi(sp)
		id, err := st.AddAccount(context.Background(), store.Account{Name: name, Email: email, Username: email,
			IMAPHost: ih, IMAPPort: ipn, IMAPTLS: "none", SMTPHost: sh, SMTPPort: spn, SMTPTLS: "none"})
		if err != nil {
			return err
		}
		return sec.Set(id, "demo")
	}
	cleanup := func() {
		for _, s := range servers {
			s.Close()
		}
	}
	if err := add("Alex Morgan", "alex@northwind.io", work); err != nil {
		cleanup()
		return nil, err
	}
	if err := add("Alex Morgan", "alex.morgan@fastmail.com", personal); err != nil {
		cleanup()
		return nil, err
	}
	return cleanup, nil
}
