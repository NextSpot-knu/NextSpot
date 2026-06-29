-- 1. Create inquiries table
CREATE TABLE IF NOT EXISTS public.inquiries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    user_name VARCHAR(100) NOT NULL,
    type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'resolved')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Enable RLS
ALTER TABLE public.inquiries ENABLE ROW LEVEL SECURITY;

-- 3. Create RLS Policies
-- Allow anyone (anonymous or authenticated) to insert inquiries
CREATE POLICY "Allow anonymous or auth inserts on inquiries" 
ON public.inquiries FOR INSERT 
WITH CHECK (true);

-- Allow everyone to select, update, or delete inquiries for simplified testing and management
CREATE POLICY "Allow all select/update/delete on inquiries" 
ON public.inquiries FOR ALL 
USING (true);

-- 4. Create update trigger for updated_at
CREATE TRIGGER update_inquiries_modtime
    BEFORE UPDATE ON public.inquiries
    FOR EACH ROW
    EXECUTE PROCEDURE public.handle_updated_at();
