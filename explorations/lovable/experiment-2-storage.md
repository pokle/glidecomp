# Lovable experiment 2 - Storage

I want to learn about how it manages storage, authentication, and authorization.

# Prompt

I want to add the ability to store tracklogs forever. For that I need the concept of users that can login and add tracklogs. They might be creating tracklogs on behalf of other pilots.  Once tracklogs are in the system, they should have a unique publicly shareable URL. And it should then be possible to pick up all tracks that were flown close in time and location to the currently focused track - showing a gaggle automatically. Kinda like a Facebook for tracklogs.  How do we recommend we build this?

# Conversation

https://lovable.dev/projects/3e8062b7-8f9a-4145-bf1c-615d77a59bf9?messageId=aimsg_01kf6sfex1e4a9k7t7n1rmwbkm

This is a great feature expansion! Let me outline a recommended architecture and ask a few questions before we build.

## Recommended Architecture

**Database Schema:**
- `pilots` - pilot profiles (name, email, optional user link)
- `tracklogs` - stored IGC data with metadata (pilot, date, location, duration, unique slug)
- `user_roles` - for admin capabilities

**Key Features:**
1. **Auth** - Email/password login via Lovable Cloud
2. **Tracklog storage** - Parse IGC → store metadata + raw file in storage
3. **Shareable URLs** - `/track/:slug` with unique slugs
4. **Auto-gaggle** - Query tracks within ±2 hours and ~50km of takeoff location

**Gaggle Detection Logic:**
```sql
-- Find nearby tracks by comparing takeoff time & location
WHERE ABS(EXTRACT(EPOCH FROM (t.takeoff_time - reference_time))) < 7200
  AND earth_distance(ll_to_earth(t.lat, t.lng), ll_to_earth(ref_lat, ref_lng)) < 50000
```

# Questions it asked

q: Should pilots need an account to have tracks uploaded for them, or can registered users tag any pilot name?

a: Registerd user can upload any tracks. Tracks will contain pilot names. If not, they must default to ‘pilot-{track_slug}’

q: Who should be able to upload tracklogs?

a: Registered users only

q: What metadata should be stored with each track?

a:Extended

# Cloud

Great answers! Let me enable Lovable Cloud and then design the architecture.

Built-in backend

Database, storage, authentication, and backend logic—all ready to use.

Add an LLM to your app

Powerful AI models with zero setup. Add chat, image generation, and text analysis instantly.

Free to start, pay as you scale

Free usage included everywhere. Top up on paid plans. Track usage in Settings → Usage.

Note: This can't be undone once enabled.

# Database

```sql
-- Create profiles table for registered users
CREATE TABLE public.profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create tracklogs table
CREATE TABLE public.tracklogs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  pilot_name TEXT NOT NULL,
  flight_date DATE NOT NULL,
  duration_seconds INTEGER,
  distance_km NUMERIC(10, 2),
  max_altitude_m INTEGER,
  glider_type TEXT,
  site_name TEXT,
  flight_type TEXT DEFAULT 'local',
  comments TEXT,
  takeoff_lat NUMERIC(10, 6),
  takeoff_lng NUMERIC(10, 6),
  takeoff_time TIMESTAMP WITH TIME ZONE,
  file_path TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create indexes for gaggle detection queries
CREATE INDEX idx_tracklogs_takeoff_time ON public.tracklogs(takeoff_time);
CREATE INDEX idx_tracklogs_takeoff_location ON public.tracklogs(takeoff_lat, takeoff_lng);
CREATE INDEX idx_tracklogs_slug ON public.tracklogs(slug);

-- Enable RLS on both tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracklogs ENABLE ROW LEVEL SECURITY;

-- Helper function to check track ownership
CREATE OR REPLACE FUNCTION public.is_track_owner(track_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tracklogs
    WHERE id = track_id AND user_id = auth.uid()
  )
$$;

-- Profiles RLS policies
CREATE POLICY "Users can view their own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own profile"
  ON public.profiles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own profile"
  ON public.profiles FOR DELETE
  USING (auth.uid() = user_id);

-- Tracklogs RLS policies
CREATE POLICY "Anyone can view tracklogs"
  ON public.tracklogs FOR SELECT
  USING (true);

CREATE POLICY "Authenticated users can insert tracklogs"
  ON public.tracklogs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own tracklogs"
  ON public.tracklogs FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own tracklogs"
  ON public.tracklogs FOR DELETE
  USING (auth.uid() = user_id);

-- Create storage bucket for IGC files
INSERT INTO storage.buckets (id, name, public)
VALUES ('tracklog_files', 'tracklog_files', true);

-- Storage policies for tracklog files
CREATE POLICY "Anyone can view tracklog files"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'tracklog_files');

CREATE POLICY "Authenticated users can upload tracklog files"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'tracklog_files' AND auth.role() = 'authenticated');

CREATE POLICY "Users can delete their own tracklog files"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'tracklog_files' AND 
    auth.uid()::text = (storage.foldername(name))[1]
  );

-- Function to update timestamps
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Triggers for automatic timestamp updates
CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_tracklogs_updated_at
  BEFORE UPDATE ON public.tracklogs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Function to auto-create profile on user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (user_id, username)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Trigger to auto-create profile
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- Function to generate unique slug
CREATE OR REPLACE FUNCTION public.generate_unique_slug()
RETURNS TEXT AS $$
DECLARE
  new_slug TEXT;
  slug_exists BOOLEAN;
BEGIN
  LOOP
    new_slug := lower(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
    SELECT EXISTS(SELECT 1 FROM public.tracklogs WHERE slug = new_slug) INTO slug_exists;
    EXIT WHEN NOT slug_exists;
  END LOOP;
  RETURN new_slug;
END;
$$ LANGUAGE plpgsql SET search_path = public;
```

# All done

I've set up the foundation for your tracklog social platform with:

Database:

- profiles - auto-created on signup
- tracklogs - stores flight metadata with unique slugs, takeoff location/time for gaggle detection
- Storage bucket for IGC files

Features implemented:

- /auth - Login/signup page
- /track/:slug - Shareable track URLs with auto-gaggle detection (finds tracks within ±2 hours & 50km)
- Save tracks to cloud with metadata (pilot name, glider, site, comments)
- My saved tracks list in sidebar
- Auto-gaggle finds other pilots who flew nearby automatically when viewing a track!


# Security issues

- Pilot Personal Information Exposed to Anyone on the Internet
  - The 'tracklogs' table is publicly readable (policy: 'Anyone can view tracklogs') and contains pilot names, exact GPS coordinates of takeoff locations, flight dates, and potentially identifiable flight patterns. This data could be used to stalk pilots, identify their homes or regular flying locations, or track their movements over time. Restrict SELECT access to authenticated users only, or implement a policy that allows public viewing of anonymized/aggregated data while protecting personal details.
- Precise GPS Coordinates Could Reveal Pilot Home Addresses
  - The 'tracklogs' table exposes takeoff_lat and takeoff_lng coordinates publicly. Combined with flight_date and pilot_name, this creates a detailed movement history that could reveal where pilots live, work, or regularly fly. Consider implementing a policy that fuzzes coordinates for public access or only shows site_name instead of exact GPS data for non-authenticated users.


To ignore these, I had to provide a reason. My reasoning was:
> Pilots upload tracklogs publicly because they want to share them. The tracklogs are not over their homes or anywhere personal. Flying is carried out over public places.

# Result

When I tried the upload feature, it didn't work. Sounds like I need to publish it.

```
lovable.js:1 Failed to execute 'postMessage' on 'DOMWindow': The target origin provided ('https://lovable.dev') does not match the recipient window's origin ('https://preview--gaggle.lovable.app').
B	@	lovable.js:1
```

I also noticed that the [trackLogService](https://github.com/pokle/gaggle-glider/blob/main/src/services/tracklogService.ts#L83) uses a filepath in the user's directory to save files

```typescript
const filePath = `${user.id}/${slug}.igc`;
````

So I published it.

Then I found that the upload dialog was showing up underneath the map. I had Claude Code fix that bug. https://github.com/pokle/gaggle-glider/commit/99501a53f0ba10a24f27407ec94afcd0881afa74 

# Changes I want

- Unify the 'Replace your track', 'Upload your track', and 'Save your track' buttons into a single 'Upload track' button.
  - There's no need to differentiate between these actions.
  - The button should allow multiple tracks to be uploaded at once.
  - The dialog needs to go - I don't want to be entering all the details manually. The pilot name should come from the IGC file - it's already in there in the HFPLTPILOT field. 
  - When there are multiple tracks in the view, it should be possible to focus on the primary track by clicking a link next to the track name.
  - When logged in, the tracks should automatically be saved the user's account.
- Remove these fields from the tracklogs table:
  - glider_type
  - site_name
  - flight_type
